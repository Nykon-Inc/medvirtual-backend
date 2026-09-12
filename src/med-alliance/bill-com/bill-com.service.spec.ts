import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { BillComService } from './bill-com.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BillComSessionRequiredException } from './bill-com-session-required.exception';
import { BillComAlreadyEnrolledException } from './bill-com-already-enrolled.exception';
import { BillComNoDeviceException } from './bill-com-no-device.exception';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  uSER: {
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
  },
};

const baseUser = {
  id: 'admin-1',
  email: 'admin@medvirtual.ai',
  billcom_remember_me_id: null as string | null,
  billcom_device: null as string | null,
  billcom_session_id: null as string | null,
  billcom_session_expires: null as Date | null,
};

describe('BillComService', () => {
  let service: BillComService;

  beforeEach(async () => {
    process.env.BILLCOM_ORGANIZATION_ID = 'org-1';
    process.env.BILLCOM_DEV_KEY = 'dev-key';
    process.env.BILLCOM_FUNDING_ACCOUNT_ID = 'fund-1';
    process.env.BILLCOM_BASE_URL = 'https://gateway.stage.bill.com/connect/v3';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillComService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<BillComService>(BillComService);
  });

  afterEach(() => jest.clearAllMocks());

  // ---------------------------------------------------------------------
  // login
  // ---------------------------------------------------------------------
  describe('login', () => {
    it('persists a trusted session to billcom_session_id and clears pending', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockResolvedValue({
        data: {
          sessionId: 'sess-1',
          trusted: true,
          organizationId: 'org-1',
          userId: 'u-1',
        },
      } as any);

      const result = await service.login('admin-1', {
        username: 'admin@medvirtual.ai',
        password: 'secret',
      });

      expect(result).toEqual({ sessionId: 'sess-1', trusted: true });
      expect(mockPrisma.uSER.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({
            billcom_session_id: 'sess-1',
            billcom_pending_session_id: null,
          }),
        }),
      );
    });

    it('holds an untrusted session only in billcom_pending_session_id, never billcom_session_id', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockResolvedValue({
        data: {
          sessionId: 'sess-2',
          trusted: false,
          organizationId: 'org-1',
          userId: 'u-1',
        },
      } as any);

      const result = await service.login('admin-1', {
        username: 'admin@medvirtual.ai',
        password: 'secret',
      });

      expect(result).toEqual({ sessionId: 'sess-2', trusted: false });
      expect(mockPrisma.uSER.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { billcom_pending_session_id: 'sess-2' },
      });
    });

    it('includes rememberMeId/device from stored user fields when present', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        billcom_remember_me_id: 'remember-1',
        billcom_device: 'MedVirtual Admin - admin@medvirtual.ai',
      });
      mockedAxios.post.mockResolvedValue({
        data: {
          sessionId: 'sess-3',
          trusted: true,
          organizationId: 'org-1',
          userId: 'u-1',
        },
      } as any);

      await service.login('admin-1', {
        username: 'admin@medvirtual.ai',
        password: 'secret',
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/login'),
        expect.objectContaining({
          rememberMeId: 'remember-1',
          device: 'MedVirtual Admin - admin@medvirtual.ai',
        }),
        expect.anything(),
      );
    });

    it('wraps a Bill.com error into a BadGatewayException', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockRejectedValue({
        response: { data: { message: 'invalid credentials' } },
      });

      await expect(
        service.login('admin-1', { username: 'x', password: 'y' }),
      ).rejects.toThrow('Bill.com login failed: invalid credentials');
    });

    it('extracts the message when Bill.com returns an error array at the response root', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockRejectedValue({
        response: {
          data: [
            {
              code: 'BDC_5324',
              severity: 'ERROR',
              message: 'Mfa action blocked.',
            },
          ],
        },
      });

      await expect(
        service.login('admin-1', { username: 'x', password: 'y' }),
      ).rejects.toThrow('Bill.com login failed: Mfa action blocked.');
    });
  });

  // ---------------------------------------------------------------------
  // hasValidSession
  // ---------------------------------------------------------------------
  describe('hasValidSession', () => {
    it('returns false when no session is stored', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      await expect(service.hasValidSession('admin-1')).resolves.toBe(false);
    });

    it('returns false when the session is expired', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        billcom_session_id: 'sess-1',
        billcom_session_expires: new Date(Date.now() - 1000),
      });
      await expect(service.hasValidSession('admin-1')).resolves.toBe(false);
    });

    it('returns true when the session is valid and not expired', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        billcom_session_id: 'sess-1',
        billcom_session_expires: new Date(Date.now() + 1000 * 60),
      });
      await expect(service.hasValidSession('admin-1')).resolves.toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // requestMfaChallenge / validateMfaChallenge
  // ---------------------------------------------------------------------
  describe('requestMfaChallenge', () => {
    it('returns the challengeId from Bill.com', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { challengeId: 'chal-1' },
      } as any);
      await expect(
        service.requestMfaChallenge('admin-1', 'sess-1'),
      ).resolves.toEqual({ challengeId: 'chal-1' });
    });

    it('throws BillComNoDeviceException on BDC_1354 (no MFA device configured)', async () => {
      mockedAxios.post.mockRejectedValue({
        response: {
          data: [
            {
              code: 'BDC_1354',
              severity: 'ERROR',
              message:
                'Specified 2-Step Verification phone is not setup or is invalid.',
            },
          ],
        },
      });

      await expect(
        service.requestMfaChallenge('admin-1', 'sess-1'),
      ).rejects.toThrow(BillComNoDeviceException);
    });

    it('does NOT treat BDC_1570 (Shield) as no-device — surfaces as a normal error', async () => {
      mockedAxios.post.mockRejectedValue({
        response: {
          data: [
            {
              code: 'BDC_1570',
              severity: 'ERROR',
              message: 'Shield Service Errors.',
            },
          ],
        },
      });

      await expect(
        service.requestMfaChallenge('admin-1', 'sess-1'),
      ).rejects.not.toThrow(BillComNoDeviceException);
    });
  });

  describe('validateMfaChallenge', () => {
    it('persists rememberMeId + device for future logins, and trusts the already-authenticated session directly', async () => {
      mockPrisma.uSER.findUniqueOrThrow
        // resolveDeviceLabel (inside validateMfaChallenge)
        .mockResolvedValueOnce({ ...baseUser, billcom_device: null });
      mockedAxios.post.mockResolvedValueOnce({
        data: { rememberMeId: 'remember-1' },
      } as any); // mfa/challenge/validate

      const result = await service.validateMfaChallenge(
        'admin-1',
        'sess-1',
        'chal-1',
        '123456',
      );

      // No second /login call — the sessionId passed in is already trusted.
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ sessionId: 'sess-1', trusted: true });
      expect(mockPrisma.uSER.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          billcom_remember_me_id: 'remember-1',
          billcom_device: 'MedVirtual Admin - admin@medvirtual.ai',
          billcom_session_id: 'sess-1',
          billcom_session_expires: expect.any(Date),
          billcom_pending_session_id: null,
        },
      });
    });

    it('wraps and throws when the code itself is invalid, without persisting anything', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValueOnce({ ...baseUser });
      mockedAxios.post.mockRejectedValueOnce({
        response: { data: [{ code: 'BDC_9999', message: 'Invalid code' }] },
      });

      await expect(
        service.validateMfaChallenge('admin-1', 'sess-1', 'chal-1', '000000'),
      ).rejects.toThrow();
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockPrisma.uSER.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // addPhoneForMfaSetup / validatePhoneForMfaSetup
  // ---------------------------------------------------------------------
  describe('addPhoneForMfaSetup', () => {
    it('posts to /mfa/setup with exactly the documented payload (no device/primary)', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { setupId: 'setup-1' },
      } as any);

      const result = await service.addPhoneForMfaSetup(
        'admin-1',
        'sess-1',
        '+14155552671',
      );

      expect(result).toEqual({ setupId: 'setup-1' });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/mfa/setup'),
        { phone: '+14155552671', type: 'TEXT' },
        expect.anything(),
      );
      // device/primary are not part of Bill.com's documented contract for
      // this endpoint; sending them was a plausible trigger for BDC_1570
      // "Shield Service Errors."
      expect(mockPrisma.uSER.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('does NOT persist billcom_device (regression guard: premature persistence caused a BDC_5324 retry loop)', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { setupId: 'setup-1' },
      } as any);

      await service.addPhoneForMfaSetup('admin-1', 'sess-1', '+14155552671');

      expect(mockPrisma.uSER.update).not.toHaveBeenCalled();
    });

    it('throws BillComAlreadyEnrolledException on BDC_5324 (Bill.com already has a device on file)', async () => {
      mockedAxios.post.mockRejectedValue({
        response: {
          data: [
            {
              code: 'BDC_5324',
              severity: 'ERROR',
              message: 'Mfa action blocked.',
            },
          ],
        },
      });

      await expect(
        service.addPhoneForMfaSetup('admin-1', 'sess-1', '+14155552671'),
      ).rejects.toThrow(BillComAlreadyEnrolledException);
      expect(mockPrisma.uSER.update).not.toHaveBeenCalled();
    });

    it('does NOT treat BDC_1570 (Shield) as already-enrolled — surfaces as a normal error', async () => {
      mockedAxios.post.mockRejectedValue({
        response: {
          data: [
            {
              code: 'BDC_1570',
              severity: 'ERROR',
              message: 'Shield Service Errors.',
            },
          ],
        },
      });

      await expect(
        service.addPhoneForMfaSetup('admin-1', 'sess-1', '+14155552671'),
      ).rejects.not.toThrow(BillComAlreadyEnrolledException);
      await expect(
        service.addPhoneForMfaSetup('admin-1', 'sess-1', '+14155552671'),
      ).rejects.toThrow(
        'Bill.com addPhoneForMfaSetup failed: Shield Service Errors.',
      );
    });
  });

  describe('markDeviceAlreadyEnrolled', () => {
    it('persists billcom_device using the same fallback label as resolveDeviceLabel', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });

      await service.markDeviceAlreadyEnrolled('admin-1');

      expect(mockPrisma.uSER.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { billcom_device: 'MedVirtual Admin - admin@medvirtual.ai' },
      });
    });

    it('reuses the existing billcom_device label if one is already set', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        billcom_device: 'existing-device-label',
      });

      await service.markDeviceAlreadyEnrolled('admin-1');

      expect(mockPrisma.uSER.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { billcom_device: 'existing-device-label' },
      });
    });

    it('does NOT persist billcom_device (regression guard: premature persistence caused a BDC_5324 retry loop)', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockResolvedValue({
        data: { setupId: 'setup-1' },
      } as any);

      await service.addPhoneForMfaSetup('admin-1', 'sess-1', '+14155552671');

      expect(mockPrisma.uSER.update).not.toHaveBeenCalled();
    });
  });

  describe('validatePhoneForMfaSetup', () => {
    it('persists billcom_device on SUCCESS', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockResolvedValue({
        data: { status: 'SUCCESS' },
      } as any);

      const result = await service.validatePhoneForMfaSetup(
        'admin-1',
        'sess-1',
        'setup-1',
        '654321',
      );

      expect(result).toEqual({ status: 'SUCCESS' });
      expect(mockPrisma.uSER.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { billcom_device: 'MedVirtual Admin - admin@medvirtual.ai' },
      });
    });

    it('does NOT persist billcom_device when Bill.com rejects the code', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockResolvedValue({ data: { status: 'FAILED' } } as any);

      const result = await service.validatePhoneForMfaSetup(
        'admin-1',
        'sess-1',
        'setup-1',
        '000000',
      );

      expect(result).toEqual({ status: 'FAILED' });
      expect(mockPrisma.uSER.update).not.toHaveBeenCalled();
    });

    it('does NOT persist billcom_device when the Bill.com call throws (e.g. BDC_5324)', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });
      mockedAxios.post.mockRejectedValue({
        response: {
          data: [
            {
              code: 'BDC_5324',
              severity: 'ERROR',
              message: 'Mfa action blocked.',
            },
          ],
        },
      });

      await expect(
        service.validatePhoneForMfaSetup(
          'admin-1',
          'sess-1',
          'setup-1',
          '654321',
        ),
      ).rejects.toThrow('Mfa action blocked.');

      expect(mockPrisma.uSER.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // createBillAndPayment
  // ---------------------------------------------------------------------
  describe('createBillAndPayment', () => {
    const params = {
      vendorId: 'vendor-1',
      amount: 150,
      processDate: '2026-06-01',
      description: 'Payment for affiliate',
    };

    it('throws BillComSessionRequiredException when the admin has no valid session', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({ ...baseUser });

      await expect(
        service.createBillAndPayment('admin-1', params),
      ).rejects.toThrow(BillComSessionRequiredException);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('creates the bill and payment using the stored session', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        billcom_session_id: 'sess-1',
        billcom_session_expires: new Date(Date.now() + 1000 * 60),
      });
      mockedAxios.post.mockResolvedValue({
        data: {
          id: 'pay-1',
          billId: 'bill-1',
          status: 'SCHEDULED',
          confirmationNumber: 'conf-1',
          transactionNumber: 'txn-1',
        },
      } as any);

      const result = await service.createBillAndPayment('admin-1', params);

      expect(result).toEqual({
        paymentId: 'pay-1',
        billId: 'bill-1',
        status: 'SCHEDULED',
        confirmationNumber: 'conf-1',
        transactionNumber: 'txn-1',
      });
    });

    it('invalidates the session and throws BillComSessionRequiredException on a 401 mid-call', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        ...baseUser,
        billcom_session_id: 'sess-1',
        billcom_session_expires: new Date(Date.now() + 1000 * 60),
      });
      mockedAxios.post.mockRejectedValue({ response: { status: 401 } });

      await expect(
        service.createBillAndPayment('admin-1', params),
      ).rejects.toThrow(BillComSessionRequiredException);

      expect(mockPrisma.uSER.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { billcom_session_id: null, billcom_session_expires: null },
      });
    });
  });

  // ---------------------------------------------------------------------
  // End-to-end guarantee: a session is only usable for payments once it has
  // been persisted as billcom_session_id — either via login() returning
  // trusted:true directly, or via validateMfaChallenge() confirming the MFA
  // code on an already-authenticated session (see paymentCredentials.md
  // line 122, "The flow can be started only if the login api returns
  // trusted: true", and lines 74-78 on rememberMeId being for the *next*
  // login, not proof of the current one). These tests use a stateful fake
  // Prisma (real read-your-writes) so the whole login -> validateMfaChallenge
  // -> createBillAndPayment chain runs through the real service methods, not
  // step-by-step mocks.
  // ---------------------------------------------------------------------
  describe('end-to-end: payments require an actual trusted:true login', () => {
    let statefulPrisma: {
      uSER: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    };
    let statefulService: BillComService;
    let userRow: typeof baseUser & {
      billcom_pending_session_id: string | null;
    };

    beforeEach(async () => {
      userRow = {
        ...baseUser,
        billcom_pending_session_id: null,
      };
      statefulPrisma = {
        uSER: {
          findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...userRow })),
          update: jest.fn(({ data }) => {
            Object.assign(userRow, data);
            return Promise.resolve({ ...userRow });
          }),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BillComService,
          { provide: PrismaService, useValue: statefulPrisma },
        ],
      }).compile();
      statefulService = module.get<BillComService>(BillComService);
    });

    it('never grants a payable session on login alone when trusted is false — only a validated MFA code (or a later trusted:true login) does', async () => {
      // 1) Initial login comes back untrusted.
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          sessionId: 'sess-pending',
          organizationId: 'org-1',
          userId: 'admin-1',
          trusted: false,
        },
      } as any);
      const loginResult = await statefulService.login('admin-1', {
        username: 'admin@medvirtual.ai',
        password: 'secret123',
      });
      expect(loginResult.trusted).toBe(false);

      // Untrusted login must not create a payable session.
      await expect(
        statefulService.createBillAndPayment('admin-1', {
          vendorId: 'vendor-1',
          amount: 100,
          processDate: '2026-06-01',
          description: 'test',
        }),
      ).rejects.toThrow(BillComSessionRequiredException);

      // 2) MFA code is validated successfully — this alone confirms the
      // pending session as trusted, no second /login involved.
      mockedAxios.post.mockResolvedValueOnce({
        data: { rememberMeId: 'remember-1' },
      } as any);

      const validateResult = await statefulService.validateMfaChallenge(
        'admin-1',
        'sess-pending',
        'chal-1',
        '123456',
      );
      expect(validateResult).toEqual({
        sessionId: 'sess-pending',
        trusted: true,
      });

      // Now payments are unlocked, using the MFA-validated session directly.
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          id: 'pay-1',
          billId: 'bill-1',
          status: 'SCHEDULED',
          confirmationNumber: 'conf-1',
          transactionNumber: 'txn-1',
        },
      } as any);
      const payment = await statefulService.createBillAndPayment('admin-1', {
        vendorId: 'vendor-1',
        amount: 100,
        processDate: '2026-06-01',
        description: 'test',
      });
      expect(payment.paymentId).toBe('pay-1');

      // The payable session must be the one confirmed by the MFA validation.
      expect(userRow.billcom_session_id).toBe('sess-pending');
    });
  });
});
