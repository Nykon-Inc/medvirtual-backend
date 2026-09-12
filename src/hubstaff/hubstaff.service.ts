import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';
import Bottleneck from 'bottleneck';
import { SecretsService } from '../secrets/secrets.service';
import * as redis from 'redis';
import { keyPrefix } from '../common/app-config';
import {
  HubstaffMember,
  HubstaffUser,
  HubstaffTimeOffRequest,
} from './hubstaff.interface';

export enum ActivityType {
  WORK = 'WORK',
}

export interface IncomingActivityInterface {
  project_id: number;
  date: string;
  overall: number;
  tracked: number;
  input_tracked?: number;
  user_id: number;
}

export interface ActivityAttributes {
  id?: number;
  clientId: number;
  day: string;
  overall: number;
  type: ActivityType;
  performance: number;
  screenshots: any[];
  total_time_logged: number;
  user_id: number;
  user_name?: string;
  created_at?: Date;
  updated_at?: Date;
}

@Injectable()
export class HubstaffService implements OnModuleInit {
  private readonly keyPrefix: string;
  private globalRefreshLimiter: Bottleneck;
  private refreshQueues: Record<string, Bottleneck>;
  private hubstaffGlobalLimiter: Bottleneck;
  private organizationId: string = '355251';
  private readonly API_BASE_URL = 'https://api.hubstaff.com/';

  constructor(
    private readonly configService: ConfigService,
    private readonly secretsService: SecretsService,
    @Inject('REDIS_CLIENT') private readonly redisClient: redis.RedisClientType,
  ) {
    this.keyPrefix = keyPrefix(this.configService);

    // Layer 1: Global Refresh Limit Gate
    this.globalRefreshLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 1000,
    });

    // Layer 2: Per-rotation Queue (ensures atomicity of the token cache)
    this.refreshQueues = {
      '1': new Bottleneck({ maxConcurrent: 1 }),
      '2': new Bottleneck({ maxConcurrent: 1 }),
      '3': new Bottleneck({ maxConcurrent: 1 }),
      '4': new Bottleneck({ maxConcurrent: 1 }),
    };

    // Centralized request handler for all Hubstaff API calls.
    this.hubstaffGlobalLimiter = new Bottleneck({
      reservoir: 40,
      reservoirRefreshAmount: 40,
      reservoirRefreshInterval: 60 * 1000,
      maxConcurrent: 10,
      minTime: 200,
    });
  }

  onModuleInit() {
    console.log('🚀 HubstaffService initialized');
  }

  /**
   * Redis-like getter using actual Redis client
   */
  private async redisGet(key: string): Promise<string | null> {
    return await this.redisClient.get(key);
  }

  /**
   * Redis-like setter using actual Redis client
   */
  private async redisSet(
    key: string,
    value: string,
    options?: { EX: number },
  ): Promise<void> {
    if (options?.EX) {
      await this.redisClient.set(key, value, { EX: options.EX });
    } else {
      await this.redisClient.set(key, value);
    }
  }

  private _getConfig(): string {
    return 'https://account.hubstaff.com/access_tokens';
  }

  private async isAnyTokenAvailable(): Promise<boolean> {
    for (let i = 1; i <= 4; i++) {
      const key = `${this.keyPrefix}hubstaff_token_${i}`;
      const cached = await this.redisGet(key);
      if (cached !== '__RATE_LIMIT__') {
        return true;
      }
    }
    return false;
  }

  /**
   * Internal method to exchange refresh token for access token.
   */
  public async _getAccessToken_new(token_endpoint: string, rotation: string) {
    const key = `${this.keyPrefix}hubstaff_token_${rotation}`;
    const cached = await this.redisGet(key);

    if (cached && cached !== '__RATE_LIMIT__') {
      return cached;
    }

    // Layer 1: Global Refresh Limit Gate
    return this.globalRefreshLimiter.schedule(async () => {
      // Layer 2: Per-rotation Queue (ensures atomicity of the token cache)
      return this.refreshQueues[rotation].schedule(async () => {
        // Check cache *again* after waiting in the two queues
        const cachedInside = await this.redisGet(key);
        if (cachedInside && cachedInside !== '__RATE_LIMIT__') {
          return cachedInside;
        }

        // Fetch refresh token from secrets
        const secrets = await this.secretsService.getAllSecrets();
        const hubstaffKeys = secrets.hubstaff;
        const refreshToken =
          hubstaffKeys[`key0${rotation}` as keyof typeof hubstaffKeys];
        if (!refreshToken) {
          console.warn(
            `[Hubstaff] ⚠️ Refresh token for rotation ${rotation} not found in secrets.`,
          );
          return null;
        }

        const params = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });

        try {
          const res = await axios.post(token_endpoint, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10_000,
          });

          const { access_token, expires_in } = res.data;
          await this.redisSet(key, access_token, { EX: expires_in });
          return access_token;
        } catch (err: any) {
          const errorData = err.response?.data;
          if (errorData?.error === 'rate_limit') {
            console.warn(
              `[Hubstaff] 🚦 Rate limit hit on token refresh (rotation ${rotation})`,
            );
            // Mark the token as rate-limited for 1 hour
            await this.redisSet(key, '__RATE_LIMIT__', { EX: 3600 });
            return null;
          }
          console.error(
            `[Hubstaff] ❌ Error refreshing token for rotation ${rotation}:`,
            err.message,
          );
          throw err;
        }
      });
    });
  }

  /**
   * Centralized request handler for all Hubstaff API calls.
   */
  public async hubstaffRequest<T = any>(
    method: 'get' | 'post' | 'put' | 'delete',
    endpoint: string,
    opts: { params?: any; data?: any; retryCount?: number } = {},
  ): Promise<AxiosResponse<T>> {
    return this.hubstaffGlobalLimiter.schedule(async () => {
      const { params, data, retryCount = 0 } = opts;

      // 🛑 Graceful Pause/Throttle Check
      let pauseCount = 0;
      while (!(await this.isAnyTokenAvailable())) {
        pauseCount++;
        const pauseTimeMs = 60_000; // Pause for 60 seconds

        if (pauseCount === 1) {
          console.warn(
            `[Hubstaff] 🚧 All tokens are marked rate-limited. Idling for ${pauseTimeMs / 1000}s until one resets.`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, pauseTimeMs));
      }

      const rotationKey = `${this.keyPrefix}hubstaff_token_rotation`;

      // Determine which rotation token to use based on simple round-robin
      let rotation = (await this.redisGet(rotationKey)) || '1';

      const tokenEndpoint = this._getConfig();
      let accessToken: string | null = null;
      let rotationAttempts = 0;

      // Loop to find the next available token (skip rate-limited ones)
      while (rotationAttempts < 4) {
        accessToken = await this._getAccessToken_new(tokenEndpoint, rotation);

        if (accessToken && accessToken !== '__RATE_LIMIT__') {
          break;
        }

        console.warn(
          `[Hubstaff] ❌ Rotation ${rotation} unavailable, switching to next.`,
        );

        // Cycle to the next rotation for the next attempt/next request
        rotation = rotation === '4' ? '1' : (Number(rotation) + 1).toString();
        rotationAttempts++;

        if (rotationAttempts >= 4) {
          throw new Error(
            `[Hubstaff] ❌ All token rotations unavailable after ${rotationAttempts} checks.`,
          );
        }
      }

      // Atomically set the NEXT rotation for the *next* hubstaffRequest call
      const nextRotation =
        rotation === '4' ? '1' : (Number(rotation) + 1).toString();
      await this.redisSet(rotationKey, nextRotation);

      if (!accessToken) {
        throw new Error('[Hubstaff] Failed to secure an access token.');
      }

      try {
        const res = await axios.request({
          method,
          url: endpoint,
          params,
          data,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
          validateStatus: () => true,
        });

        // ⚠️ Cloudflare HTML / 520 handling
        if (
          typeof res.data === 'string' &&
          res.data.includes('<!DOCTYPE html>') &&
          res.data.includes('cloudflare.com')
        ) {
          if (retryCount < 5) {
            const delay = 1000 * Math.pow(2, retryCount + 1);
            console.log(
              `[Hubstaff] 🕐 Retrying Cloudflare 520 after ${delay / 1000}s`,
            );
            await new Promise((r) => setTimeout(r, delay));
            return this.hubstaffRequest(method, endpoint, {
              params,
              data,
              retryCount: retryCount + 1,
            });
          }
          throw new Error(`[Hubstaff] ❌ Max retries for Cloudflare 520`);
        }

        // ✅ Normal successful JSON
        if (res.status >= 200 && res.status < 300) {
          return res;
        }

        // 🚦 Handle explicit rate limits (429 or code: 'rate_limit')
        const code = res.data?.code;
        if (res.status === 429 || code === 'rate_limit') {
          console.warn(`[Hubstaff] 🚦 Rate limit hit (rotation ${rotation})`);

          // Explicitly mark the token as rate-limited for 1 hour to skip it
          await this.redisSet(
            `${this.keyPrefix}hubstaff_token_${rotation}`,
            '__RATE_LIMIT__',
            { EX: 3600 },
          );

          if (retryCount < 3) {
            const delay = 2000 * (retryCount + 1);
            console.log(`[Hubstaff] ⏳ Backing off ${delay / 1000}s`);
            await new Promise((r) => setTimeout(r, delay));

            return this.hubstaffRequest(method, endpoint, {
              params,
              data,
              retryCount: retryCount + 1,
            });
          }
          throw new Error(`[Hubstaff] ❌ Max rate limit retries failed.`);
        }

        // 🔁 Handle expired token (401)
        if (res.status === 401 && retryCount < 2) {
          console.log(
            `[Hubstaff] 🔁 Token expired. Forcing refresh on rotation ${rotation}`,
          );
          await this._getAccessToken_new(tokenEndpoint, rotation);

          return this.hubstaffRequest(method, endpoint, {
            params,
            data,
            retryCount: retryCount + 1,
          });
        }

        console.error(`[Hubstaff] Error response:`, res.data);
        throw new Error(
          `[Hubstaff] ❌ Unexpected status ${res.status} - ${res.statusText}`,
        );
      } catch (err: any) {
        console.error(
          `[Hubstaff] ❌ Network error on ${endpoint.split('?')[0]}:`,
          err.message,
        );
        throw err;
      }
    });
  }

  /**
   * Fetches a project by ID.
   */
  public async getProjectById(projectId: string) {
    const res = await this.hubstaffRequest(
      'get',
      `https://api.hubstaff.com/v2/projects/${projectId}`,
    );
    return res.data;
  }

  /**
   * Fetches all members in a project with pagination support.
   * API: https://developer.hubstaff.com/docs/hubstaff_v2#tag/members/GET/v2/projects/{project_id}/members
   */
  public async getProjectMembers(projectId: string) {
    let allMembers: any[] = [];
    let nextPageStartId: number | undefined = undefined;

    do {
      const params: any = {};
      if (nextPageStartId) {
        params.page_start_id = nextPageStartId;
      }
      params.membership_roles = 'user';
      params.include = 'users';
      const res = await this.hubstaffRequest(
        'get',
        `https://api.hubstaff.com/v2/projects/${projectId}/members`,
        {
          params,
        },
      );

      const { members, pagination, users } = res.data;
      if (members) {
        allMembers = allMembers.concat(
          members.map((e) => ({
            ...e,
            user: users.find((u) => u.id === e.user_id),
          })),
        );
      }
      nextPageStartId = pagination?.next_page_start_id;
    } while (nextPageStartId);

    return allMembers;
  }

  /**
   * Fetches daily activity records for a project within a date range and optional users.
   * API: https://developer.hubstaff.com/docs/hubstaff_v2#tag/activities/GET/v2/projects/{project_id}/activities/daily
   */
  public async getProjectDailyActivity(
    projectId: string,
    query: { startDate: string; endDate: string; userIds?: string[] },
  ) {
    let allActivities: any[] = [];
    let nextPageStartId: number | undefined = undefined;

    const { startDate, endDate, userIds } = query;
    const baseParams: any = {
      'date[start]': startDate,
      'date[stop]': endDate,
    };

    if (userIds && userIds.length > 0) {
      baseParams['user_ids'] = userIds.join(',');
    }

    do {
      const res = await this.hubstaffRequest(
        'get',
        `https://api.hubstaff.com/v2/projects/${projectId}/activities/daily`,
        {
          params: {
            ...baseParams,
            ...(nextPageStartId ? { page_start_id: nextPageStartId } : {}),
          },
        },
      );

      const { activities, pagination } = res.data;
      if (activities) {
        allActivities = allActivities.concat(activities);
      }
      nextPageStartId = pagination?.next_page_start_id;
    } while (nextPageStartId);

    return allActivities;
  }

  /**
   * Fetches all members in the organization with pagination support.
   * API: https://developer.hubstaff.com/docs/hubstaff_v2#tag/members/GET/v2/organizations/{organization_id}/members
   */
  public async getOrganizationMembers() {
    let allMembers: HubstaffMember[] = [];
    let nextPageStartId: number | undefined = undefined;

    do {
      const params: any = {};
      if (nextPageStartId) {
        params.page_start_id = nextPageStartId;
      }
      params.membership_roles = 'user';
      params.include = 'users';
      params.include_profile = true;
      const res = await this.hubstaffRequest(
        'get',
        `https://api.hubstaff.com/v2/organizations/${this.organizationId}/members`,
        {
          params,
        },
      );

      const { members, pagination, users } = res.data as {
        members: HubstaffMember[];
        pagination: any;
        users: HubstaffUser[];
      };
      if (members) {
        allMembers = allMembers.concat(
          members.map((e) => ({
            ...e,
            user: users.find((u) => u.id === e.user_id),
          })),
        );
      }
      nextPageStartId = pagination?.next_page_start_id;
    } while (nextPageStartId);

    return allMembers;
  }

  public async getHubstaffDailyActivityForInvoice({
    hubstaffId,
    start_date,
    end_date,
  }: {
    hubstaffId: number;
    start_date: string;
    end_date: string;
  }) {
    try {
      const activities: Omit<
        ActivityAttributes,
        'id' | 'created_at' | 'updated_at'
      >[] = [];
      let nextCursor: string | null = 'yes';
      while (nextCursor) {
        let q = `page_limit=500&include=users&date[start]=${start_date}&date[stop]=${end_date}`;
        if (nextCursor && nextCursor !== 'yes') {
          q += `&page_start_id=${nextCursor}`;
        }
        const res = await this.hubstaffRequest<{
          daily_activities: IncomingActivityInterface[];
          users?: { id: number; name: string }[];
          pagination: { next_page_start_id: string };
        }>(
          'get',
          `${this.API_BASE_URL}v2/projects/${hubstaffId}/activities/daily?${q}`,
        );

        const data = res.data;
        const userMap = new Map<number, string>(
          data.users?.map((u) => [u.id, u.name]) || [],
        );

        activities.push(
          ...data.daily_activities.map((activity) => ({
            clientId: Number(activity.project_id),
            day: activity.date,
            overall: activity.overall,
            type: ActivityType.WORK,
            performance:
              (activity.overall /
                (activity.input_tracked || activity.tracked)) *
              100,
            screenshots: [],
            total_time_logged: activity.tracked,
            user_id: activity.user_id,
            user_name: userMap.get(activity.user_id),
          })),
        );
        if (data.pagination) {
          nextCursor = data.pagination.next_page_start_id;
        } else {
          nextCursor = null;
        }
      }
      return activities;
    } catch (error) {
      console.log(error);
      return [];
    }
  }

  /**
   * Fetches all time off requests for the specified user IDs.
   * API: https://developer.hubstaff.com/docs/hubstaff_v2#tag/time_off_requests/GET/v2/organizations/{organization_id}/time_off_requests
   */
  public async getTimeOffRequests(
    userIds: (number | string)[],
    startDate?: string,
    endDate?: string,
  ): Promise<HubstaffTimeOffRequest[]> {
    if (!userIds || userIds.length === 0) {
      return [];
    }

    let allRequests: HubstaffTimeOffRequest[] = [];
    let nextPageStartId: any = undefined;

    do {
      const params: any = {
        user_ids: userIds.join(','),
      };
      if (startDate) {
        params['starts_at[start]'] = startDate;
      }
      if (endDate) {
        params['starts_at[stop]'] = endDate;
      }
      if (nextPageStartId) {
        params.page_start_id = nextPageStartId;
      }

      const res = await this.hubstaffRequest<{
        time_off_requests: HubstaffTimeOffRequest[];
        pagination?: { next_page_start_id: any };
      }>(
        'get',
        `https://api.hubstaff.com/v2/organizations/${this.organizationId}/time_off_requests`,
        { params },
      );

      const { time_off_requests, pagination } = res.data;
      if (time_off_requests) {
        allRequests = allRequests.concat(time_off_requests);
      }
      nextPageStartId = pagination?.next_page_start_id;
    } while (nextPageStartId);

    return allRequests;
  }
}
