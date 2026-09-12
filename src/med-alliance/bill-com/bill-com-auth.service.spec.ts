import { Test, TestingModule } from '@nestjs/testing';
import { BillComAuthService } from './bill-com-auth.service';
import { BillComService } from './bill-com.service';
import { BillComNoDeviceException } from './bill-com-no-device.exception';

const mockBillComService = {
  requestMfaChallenge: jest.fn(),
};

describe('BillComAuthService', () => {
  let service: BillComAuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillComAuthService,
        { provide: BillComService, useValue: mockBillComService },
      ],
    }).compile();

    service = module.get<BillComAuthService>(BillComAuthService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('determineNextStep', () => {
    it('returns "proceed" when the login was trusted, without touching Bill.com', async () => {
      const result = await service.determineNextStep('admin-1', {
        sessionId: 'sess-1',
        trusted: true,
      });

      expect(result).toEqual({ nextStep: 'proceed' });
      expect(mockBillComService.requestMfaChallenge).not.toHaveBeenCalled();
    });

    it('returns "mfa_challenge" with the challengeId when the MFA challenge succeeds (device exists)', async () => {
      mockBillComService.requestMfaChallenge.mockResolvedValue({
        challengeId: 'chal-1',
      });

      const result = await service.determineNextStep('admin-1', {
        sessionId: 'sess-1',
        trusted: false,
      });

      expect(mockBillComService.requestMfaChallenge).toHaveBeenCalledWith(
        'admin-1',
        'sess-1',
      );
      expect(result).toEqual({
        nextStep: 'mfa_challenge',
        challengeId: 'chal-1',
      });
    });

    it('returns "no_device_configured" when Bill.com reports no device on file (BDC_1354)', async () => {
      mockBillComService.requestMfaChallenge.mockRejectedValue(
        new BillComNoDeviceException(),
      );

      const result = await service.determineNextStep('admin-1', {
        sessionId: 'sess-1',
        trusted: false,
      });

      expect(result).toEqual({ nextStep: 'no_device_configured' });
    });

    it('rethrows any other error from the MFA challenge', async () => {
      const err = new Error('Bill.com unavailable');
      mockBillComService.requestMfaChallenge.mockRejectedValue(err);

      await expect(
        service.determineNextStep('admin-1', {
          sessionId: 'sess-1',
          trusted: false,
        }),
      ).rejects.toThrow(err);
    });
  });
});
