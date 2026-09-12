import { Test, TestingModule } from '@nestjs/testing';
import { SecretsService } from './secrets.service';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

jest.mock('@aws-sdk/client-secrets-manager', () => {
  const mClient = {
    send: jest.fn(),
  };
  return {
    SecretsManagerClient: jest.fn(() => mClient),
    GetSecretValueCommand: jest.fn((args) => args),
  };
});

describe('SecretsService', () => {
  let service: SecretsService;
  let clientMock: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SecretsService],
    }).compile();

    service = module.get<SecretsService>(SecretsService);
    clientMock = (service as any).client;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getSecret', () => {
    it('should return parsed JSON when SecretString is present', async () => {
      const expectedData = { key: 'value' };
      clientMock.send.mockResolvedValueOnce({
        SecretString: JSON.stringify(expectedData),
      });

      const result = await service.getSecret('test-secret');
      expect(result).toEqual(expectedData);
    });

    it('should return null when SecretString is absent', async () => {
      clientMock.send.mockResolvedValueOnce({});
      const result = await service.getSecret('test-secret');
      expect(result).toBeNull();
    });

    it('should return null on client errors', async () => {
      clientMock.send.mockRejectedValueOnce(new Error('AWS Error'));
      const result = await service.getSecret('test-secret');
      expect(result).toBeNull();
    });
  });

  describe('getAllSecrets', () => {
    it('should compile and structure all secrets correctly', async () => {
      jest
        .spyOn(service, 'getSecret')
        .mockImplementation(async (secretId: string) => {
          if (secretId === 'prod/stripe/key01') {
            return { stripe_secret_key: 'sk_test_123' };
          }
          if (secretId.startsWith('prod/hubstaff/')) {
            const num = secretId.substring(secretId.length - 2);
            return { api_key: `hk_${num}` };
          }
          return null;
        });

      const secrets = await service.getAllSecrets();
      expect(secrets).toEqual({
        stripe_secret_key: 'sk_test_123',
        hubstaff: {
          key01: 'hk_01',
          key02: 'hk_02',
          key03: 'hk_03',
          key04: 'hk_04',
          key05: 'hk_05',
        },
      });
    });
  });
});
