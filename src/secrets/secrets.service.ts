import { Injectable } from '@nestjs/common';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

@Injectable()
export class SecretsService {
  private client: SecretsManagerClient;

  constructor() {
    this.client = new SecretsManagerClient({
      region: 'us-east-2',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  /**
   * Fetches a secret from AWS Secrets Manager and parses it as JSON.
   */
  async getSecret(secretId: string): Promise<any> {
    try {
      const command = new GetSecretValueCommand({ SecretId: secretId });
      const response = await this.client.send(command);

      if (response.SecretString) {
        return JSON.parse(response.SecretString);
      }
      return null;
    } catch (error) {
      console.error(`❌ Error fetching secret "${secretId}":`, error.message);
      return null;
    }
  }

  /**
   * Fetches all requested Stripe and Hubstaff secrets and returns them in a single object.
   */
  async getAllSecrets() {
    console.log('🔐 Fetching application secrets from AWS...');

    const [
      stripeKey,
      hubstaff01,
      hubstaff02,
      hubstaff03,
      hubstaff04,
      hubstaff05,
    ] = await Promise.all([
      this.getSecret('prod/stripe/key01'),
      this.getSecret('prod/hubstaff/key01'),
      this.getSecret('prod/hubstaff/key02'),
      this.getSecret('prod/hubstaff/key03'),
      this.getSecret('prod/hubstaff/key04'),
      this.getSecret('prod/hubstaff/key05'),
    ]);

    return {
      stripe_secret_key: stripeKey?.stripe_secret_key || null,
      hubstaff: {
        key01: hubstaff01?.api_key || null,
        key02: hubstaff02?.api_key || null,
        key03: hubstaff03?.api_key || null,
        key04: hubstaff04?.api_key || null,
        key05: hubstaff05?.api_key || null,
      },
    };
  }
}
