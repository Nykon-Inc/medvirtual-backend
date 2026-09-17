import { Test, TestingModule } from '@nestjs/testing';
import { PusherService } from './pusher.service';
import { ConfigService } from '@nestjs/config';

// Mock the pusher module
const mockTrigger = jest.fn();
const mockAuthenticate = jest.fn();
jest.mock('pusher', () => {
  return jest.fn().mockImplementation(() => {
    return {
      trigger: mockTrigger,
      authenticate: mockAuthenticate,
    };
  });
});

describe('PusherService', () => {
  let service: PusherService;
  let configService: ConfigService;

  beforeEach(async () => {
    mockTrigger.mockClear();
    mockAuthenticate.mockClear();

    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'PUSHER_APP_ID') return 'app-123';
        if (key === 'PUSHER_KEY') return 'key-123';
        if (key === 'PUSHER_SECRET') return 'secret-123';
        if (key === 'PUSHER_CLUSTER') return 'cluster-123';
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PusherService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PusherService>(PusherService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('trigger', () => {
    it('should trigger Pusher event on a channel', async () => {
      mockTrigger.mockResolvedValueOnce({ status: 200 });

      await service.trigger('my-channel', 'my-event', { text: 'hello' });

      expect(mockTrigger).toHaveBeenCalledWith('my-channel', 'my-event', {
        text: 'hello',
      });
    });

    it('should throw an error if trigger fails', async () => {
      const error = new Error('Pusher Error');
      mockTrigger.mockRejectedValueOnce(error);

      await expect(
        service.trigger('my-channel', 'my-event', {}),
      ).rejects.toThrow('Pusher Error');
    });

    it('should not call trigger if Pusher is not initialized', async () => {
      // Invalidate pusher
      (service as any).pusher = null;
      await service.trigger('my-channel', 'my-event', {});
      expect(mockTrigger).not.toHaveBeenCalled();
    });
  });

  describe('authenticate', () => {
    it('should call pusher.authenticate', () => {
      mockAuthenticate.mockReturnValueOnce('auth-response');
      const res = service.authenticate('socket-id', 'presence-channel', {
        user_id: '1',
      });
      expect(mockAuthenticate).toHaveBeenCalledWith(
        'socket-id',
        'presence-channel',
        { user_id: '1' },
      );
      expect(res).toBe('auth-response');
    });

    it('should throw error if Pusher is not initialized', () => {
      (service as any).pusher = null;
      expect(() => service.authenticate('socket-id', 'channel')).toThrow(
        'Pusher is not initialized',
      );
    });
  });
});
