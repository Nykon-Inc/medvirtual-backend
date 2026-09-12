import { Test, TestingModule } from '@nestjs/testing';
import { HubstaffService } from './hubstaff.service';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../secrets/secrets.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HubstaffService', () => {
  let service: HubstaffService;
  let secretsService: SecretsService;
  let redisMock: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'APP_ENV') return 'local';
        if (key === 'QUEUES_ENABLED') return 'false';
        if (key === 'REDIS_KEY_PREFIX') return 'test:';
        return defaultValue;
      }),
    };

    const mockSecretsService = {
      getAllSecrets: jest.fn().mockResolvedValue({
        hubstaff: {
          key01: 'refresh-token-1',
          key02: 'refresh-token-2',
        },
      }),
    };

    redisMock = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HubstaffService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SecretsService, useValue: mockSecretsService },
        { provide: 'REDIS_CLIENT', useValue: redisMock },
      ],
    }).compile();

    service = module.get<HubstaffService>(HubstaffService);
    secretsService = module.get<SecretsService>(SecretsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('_getAccessToken_new', () => {
    it('should return cached token if available', async () => {
      redisMock.get.mockResolvedValueOnce('cached-token-abc');

      const token = await service._getAccessToken_new('http://endpoint', '1');

      expect(token).toBe('cached-token-abc');
      expect(redisMock.get).toHaveBeenCalledWith('test:hubstaff_token_1');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should fetch and cache token when cache is empty', async () => {
      redisMock.get.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          access_token: 'new-access-token',
          expires_in: 3600,
        },
      } as any);

      const token = await service._getAccessToken_new('http://endpoint', '1');

      expect(token).toBe('new-access-token');
      expect(mockedAxios.post).toHaveBeenCalled();
      expect(redisMock.set).toHaveBeenCalledWith(
        'test:hubstaff_token_1',
        'new-access-token',
        { EX: 3600 },
      );
    });

    it('should handle rate limit and store error indicator', async () => {
      redisMock.get.mockResolvedValue(null);
      const err: any = new Error('Rate Limit');
      err.response = {
        status: 429,
        data: { error: 'rate_limit' },
      };
      mockedAxios.post.mockRejectedValueOnce(err);

      const token = await service._getAccessToken_new('http://endpoint', '1');

      expect(token).toBeNull();
      expect(redisMock.set).toHaveBeenCalledWith(
        'test:hubstaff_token_1',
        '__RATE_LIMIT__',
        { EX: 3600 },
      );
    });
  });
});
