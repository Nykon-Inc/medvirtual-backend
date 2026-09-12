import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BillComAuthController } from './bill-com-auth.controller';
import { BillComService } from './bill-com.service';
import { BillComAuthService } from './bill-com-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BillComAlreadyEnrolledException } from './bill-com-already-enrolled.exception';

const mockBillComService = {
  hasValidSession: jest.fn(),
  login: jest.fn(),
  requestMfaChallenge: jest.fn(),
  validateMfaChallenge: jest.fn(),
  addPhoneForMfaSetup: jest.fn(),
  validatePhoneForMfaSetup: jest.fn(),
  markDeviceAlreadyEnrolled: jest.fn(),
};

const mockBillComAuthService = {
  determineNextStep: jest.fn(),
};

const mockPrisma = {
  uSER: {
    findUniqueOrThrow: jest.fn(),
  },
};

const mockAdmin = { id: 'admin-1', role: 'system_admin' } as any;

describe('BillComAuthController', () => {
  let controller: BillComAuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillComAuthController],
      providers: [
        { provide: BillComService, useValue: mockBillComService },
        { provide: BillComAuthService, useValue: mockBillComAuthService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    controller = module.get<BillComAuthController>(BillComAuthController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('status', () => {
    it('delegates to billComService.hasValidSession and returns { connected }', async () => {
      mockBillComService.hasValidSession.mockResolvedValue(true);

      const result = await controller.status(mockAdmin);

      expect(mockBillComService.hasValidSession).toHaveBeenCalledWith(
        'admin-1',
      );
      expect(result).toEqual({ connected: true });
    });
  });

  describe('login', () => {
    it('returns trusted + nextStep, never the sessionId', async () => {
      mockBillComService.login.mockResolvedValue({
        sessionId: 'sess-1',
        trusted: true,
      });
      mockBillComAuthService.determineNextStep.mockResolvedValue({
        nextStep: 'proceed',
      });

      const result = await controller.login(mockAdmin, {
        email: 'admin@medvirtual.ai',
        password: 'secret',
      });

      expect(mockBillComService.login).toHaveBeenCalledWith('admin-1', {
        username: 'admin@medvirtual.ai',
        password: 'secret',
      });
      expect(result).toEqual({
        trusted: true,
        nextStep: 'proceed',
        challengeId: undefined,
      });
      expect(result).not.toHaveProperty('sessionId');
    });

    it('passes through the challengeId when the next step is mfa_challenge', async () => {
      mockBillComService.login.mockResolvedValue({
        sessionId: 'sess-1',
        trusted: false,
      });
      mockBillComAuthService.determineNextStep.mockResolvedValue({
        nextStep: 'mfa_challenge',
        challengeId: 'chal-1',
      });

      const result = await controller.login(mockAdmin, {
        email: 'admin@medvirtual.ai',
        password: 'secret',
      });

      expect(result).toEqual({
        trusted: false,
        nextStep: 'mfa_challenge',
        challengeId: 'chal-1',
      });
    });
  });

  describe('mfa/challenge and mfa/validate', () => {
    it('mfaChallenge throws BadRequestException when no pending session exists', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        billcom_pending_session_id: null,
      });

      await expect(controller.mfaChallenge(mockAdmin)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockBillComService.requestMfaChallenge).not.toHaveBeenCalled();
    });

    it('mfaChallenge delegates using the stored pending sessionId', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        billcom_pending_session_id: 'pending-sess-1',
      });
      mockBillComService.requestMfaChallenge.mockResolvedValue({
        challengeId: 'chal-1',
      });

      const result = await controller.mfaChallenge(mockAdmin);

      expect(mockBillComService.requestMfaChallenge).toHaveBeenCalledWith(
        'admin-1',
        'pending-sess-1',
      );
      expect(result).toEqual({ challengeId: 'chal-1' });
    });

    it('mfaValidate delegates to validateMfaChallenge using the stored pending sessionId, and returns { success: true, trusted }', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        billcom_pending_session_id: 'pending-sess-1',
      });
      mockBillComService.validateMfaChallenge.mockResolvedValue({
        sessionId: 'sess-2',
        trusted: true,
      });

      const result = await controller.mfaValidate(mockAdmin, {
        challengeId: 'chal-1',
        token: '123456',
      });

      expect(mockBillComService.validateMfaChallenge).toHaveBeenCalledWith(
        'admin-1',
        'pending-sess-1',
        'chal-1',
        '123456',
      );
      expect(result).toEqual({ success: true, trusted: true });
      expect(result).not.toHaveProperty('rememberMeId');
    });

    it('mfaValidate propagates the error when the code is rejected', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        billcom_pending_session_id: 'pending-sess-1',
      });
      mockBillComService.validateMfaChallenge.mockRejectedValue(
        new Error('Invalid code'),
      );

      await expect(
        controller.mfaValidate(mockAdmin, {
          challengeId: 'chal-1',
          token: '000000',
        }),
      ).rejects.toThrow('Invalid code');
    });
  });

  describe('phone/setup and phone/validate', () => {
    it('phoneSetup delegates and returns setupId', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        billcom_pending_session_id: 'pending-sess-1',
      });
      mockBillComService.addPhoneForMfaSetup.mockResolvedValue({
        setupId: 'setup-1',
      });

      const result = await controller.phoneSetup(mockAdmin, {
        phone: '+14155552671',
      });

      expect(mockBillComService.addPhoneForMfaSetup).toHaveBeenCalledWith(
        'admin-1',
        'pending-sess-1',
        '+14155552671',
      );
      expect(result).toEqual({ setupId: 'setup-1', alreadyEnrolled: false });
    });

    it('phoneSetup returns { alreadyEnrolled: true } instead of throwing when Bill.com already has a device on file', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        billcom_pending_session_id: 'pending-sess-1',
      });
      mockBillComService.addPhoneForMfaSetup.mockRejectedValue(
        new BillComAlreadyEnrolledException(),
      );

      const result = await controller.phoneSetup(mockAdmin, {
        phone: '+14155552671',
      });

      expect(result).toEqual({ setupId: null, alreadyEnrolled: true });
      expect(mockBillComService.markDeviceAlreadyEnrolled).toHaveBeenCalledWith(
        'admin-1',
      );
    });

    it('phoneValidate returns { success: true }', async () => {
      mockPrisma.uSER.findUniqueOrThrow.mockResolvedValue({
        billcom_pending_session_id: 'pending-sess-1',
      });
      mockBillComService.validatePhoneForMfaSetup.mockResolvedValue({
        status: 'SUCCESS',
      });

      const result = await controller.phoneValidate(mockAdmin, {
        setupId: 'setup-1',
        token: '654321',
      });

      expect(mockBillComService.validatePhoneForMfaSetup).toHaveBeenCalledWith(
        'admin-1',
        'pending-sess-1',
        'setup-1',
        '654321',
      );
      expect(result).toEqual({ success: true });
    });
  });
});
