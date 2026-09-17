import { Test, TestingModule } from '@nestjs/testing';
import { GoogledriveService } from './googledrive.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs and path
jest.mock('fs');
jest.mock('path');

// Mock googleapis
const mockDriveFilesGet = jest.fn();
const mockDriveFilesList = jest.fn();
const mockDriveFilesExport = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    drive: jest.fn().mockImplementation(() => ({
      files: {
        get: mockDriveFilesGet,
        list: mockDriveFilesList,
        export: mockDriveFilesExport,
      },
    })),
  },
}));

import { MailService } from '../mail/mail.service';

// Mock Prisma
const prismaMock = {
  googleToken: {
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  mail_Settings: {
    create: jest.fn(),
  },
};

const MailServiceMock = {
  sendMail: jest.fn(),
};

describe('GoogledriveService', () => {
  let service: GoogledriveService;

  beforeEach(async () => {
    jest.clearAllMocks();
    (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
    (fs.createWriteStream as jest.Mock).mockReturnValue({});
    (path.resolve as jest.Mock).mockImplementation((...args) => args.join('/'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogledriveService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MailService, useValue: MailServiceMock },
      ],
    }).compile();

    service = module.get<GoogledriveService>(GoogledriveService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateAuthUrl', () => {
    it('should return a valid auth url', () => {
      const url = service.generateAuthUrl();
      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    });
  });

  describe('getTokens', () => {
    it('should throw if no code provided', async () => {
      await expect(service.getTokens('')).rejects.toThrow(BadRequestException);
    });

    it('should save tokens and return them', async () => {
      const fakeTokens = {
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'scope',
        token_type: 'Bearer',
        expiry_date: Date.now() + 10000,
      };

      jest
        .spyOn(OAuth2Client.prototype, 'getToken')
        .mockImplementation(async () => ({ tokens: fakeTokens }) as any);

      prismaMock.googleToken.create.mockResolvedValue({ id: 1 });

      const result = await service.getTokens('valid-code');
      expect(result).toEqual(fakeTokens);
      expect(prismaMock.googleToken.create).toHaveBeenCalled();
    });
  });

  describe('refreshAccessToken', () => {
    it('should return new access token and expiry', async () => {
      const mockCredentials = {
        access_token: 'new-access',
        expiry_date: Date.now() + 3600000,
      };
      jest
        .spyOn(OAuth2Client.prototype as any, 'refreshAccessToken')
        .mockResolvedValue({ credentials: mockCredentials });

      const result = await service.refreshAccessToken('refresh-token');

      expect(result.access_token).toBe('new-access');
      expect(result.expiry_date).toBe(mockCredentials.expiry_date);
    });
  });

  describe('getValidAccessToken', () => {
    it('should throw BadRequestException if no tokens found (sends email notification)', async () => {
      prismaMock.googleToken.findFirst.mockResolvedValue(null);
      MailServiceMock.sendMail.mockResolvedValue(true);
      prismaMock.mail_Settings.create.mockResolvedValue({});

      await expect(service.getValidAccessToken()).rejects.toThrow(
        BadRequestException,
      );
      expect(MailServiceMock.sendMail).toHaveBeenCalled();
      expect(prismaMock.mail_Settings.create).toHaveBeenCalledWith({
        data: { title: 'google_token_expired' },
      });
    });

    it('should log when sendMail returns false (no mail sent)', async () => {
      prismaMock.googleToken.findFirst.mockResolvedValue(null);
      MailServiceMock.sendMail.mockResolvedValue(false); // sendMail returns falsy
      prismaMock.mail_Settings.create.mockResolvedValue({});

      await expect(service.getValidAccessToken()).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return token directly when not yet expired (> 60s remaining)', async () => {
      prismaMock.googleToken.findFirst.mockResolvedValue({
        id: 1,
        accessToken: 'valid-token',
        refreshToken: 'refresh',
        expiryDate: Date.now() + 3600000,
      });

      const result = await service.getValidAccessToken();
      expect(result).toBe('valid-token');
    });

    it('should refresh and update token when expired', async () => {
      prismaMock.googleToken.findFirst.mockResolvedValue({
        id: 1,
        accessToken: 'old',
        refreshToken: 'refresh',
        expiryDate: Date.now() - 1000,
      });

      jest.spyOn(service, 'refreshAccessToken').mockResolvedValue({
        access_token: 'new',
        expiry_date: Date.now() + 10000,
      });

      prismaMock.googleToken.update.mockResolvedValue({});

      const result = await service.getValidAccessToken();
      expect(result).toBe('new');
      expect(prismaMock.googleToken.update).toHaveBeenCalled();
    });

    it('should throw BadRequestException when refresh returns no access_token', async () => {
      prismaMock.googleToken.findFirst.mockResolvedValue({
        id: 1,
        accessToken: 'old',
        refreshToken: 'refresh',
        expiryDate: Date.now() - 1000,
      });

      jest.spyOn(service, 'refreshAccessToken').mockResolvedValue({
        access_token: null,
        expiry_date: null,
      });
      MailServiceMock.sendMail.mockResolvedValue(true);
      prismaMock.mail_Settings.create.mockResolvedValue({});

      await expect(service.getValidAccessToken()).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('listFilesInFolder', () => {
    beforeEach(() => {
      jest
        .spyOn(service, 'getValidAccessToken')
        .mockResolvedValue('mock-token');
    });

    it('should return list of files in the folder', async () => {
      const mockFiles = [
        { id: 'file-1', name: 'resume.pdf', mimeType: 'application/pdf' },
        {
          id: 'file-2',
          name: 'cover.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ];
      mockDriveFilesList.mockResolvedValueOnce({ data: { files: mockFiles } });

      const result = await service.listFilesInFolder('folder-id');

      expect(mockDriveFilesList).toHaveBeenCalledWith(
        expect.objectContaining({ q: "'folder-id' in parents" }),
      );
      expect(result).toEqual(mockFiles);
    });

    it('should throw BadRequestException when drive.files.list rejects', async () => {
      mockDriveFilesList.mockRejectedValueOnce(new Error('Drive API error'));

      await expect(service.listFilesInFolder('folder-id')).rejects.toThrow(
        'Failed to list files in folder: Drive API error',
      );
    });
  });

  describe('downloadFile', () => {
    beforeEach(() => {
      jest
        .spyOn(service, 'getValidAccessToken')
        .mockResolvedValue('mock-token');
    });

    it('should return error message when drive.files.get throws', async () => {
      mockDriveFilesGet.mockRejectedValueOnce(new Error('File not found'));

      const result = await service.downloadFile(
        'fileId',
        'file.pdf',
        '/downloads',
      );

      expect(result).toBe('File not found');
    });

    it('should handle non-exportable file type via stream and return download message', async () => {
      const mockStream = {
        data: {
          on: jest.fn().mockImplementation(function (event, cb) {
            if (event === 'end') cb();
            return this;
          }),
          pipe: jest.fn(),
        },
      };
      mockDriveFilesGet
        .mockResolvedValueOnce({ data: { mimeType: 'application/pdf' } }) // metadata
        .mockResolvedValueOnce(mockStream); // media stream

      const result = await service.downloadFile(
        'fileId',
        'resume.pdf',
        '/downloads',
      );

      expect(result).toBe('Download successful');
      expect(mockDriveFilesGet).toHaveBeenCalledTimes(2);
    });

    it('should handle exportable Google Docs file type', async () => {
      mockDriveFilesGet.mockResolvedValueOnce({
        data: { mimeType: 'application/vnd.google-apps.document' },
      });
      mockDriveFilesExport.mockImplementationOnce(
        (params, options, callback) => {
          if (callback)
            callback(null, {
              data: { on: jest.fn().mockReturnThis(), pipe: jest.fn() },
            });
        },
      );

      const result = await service.downloadFile(
        'fileId',
        'doc.pdf',
        '/downloads',
      );

      expect(result).toBe('Download successful');
      expect(mockDriveFilesExport).toHaveBeenCalled();
    });
  });

  describe('downloadImage', () => {
    beforeEach(() => {
      jest
        .spyOn(service, 'getValidAccessToken')
        .mockResolvedValue('mock-token');
    });

    it('should throw error when drive.files.get throws', async () => {
      mockDriveFilesGet.mockRejectedValueOnce(new Error('Image not found'));

      await expect(
        service.downloadImage('fileId', 'img.png', '/tmp'),
      ).rejects.toThrow('Image not found');
    });

    it('should return destPath when downloading a non-exportable image', async () => {
      const mockStream = {
        data: {
          on: jest.fn().mockImplementation(function (event, cb) {
            if (event === 'end') cb();
            return this;
          }),
          pipe: jest.fn(),
        },
      };
      mockDriveFilesGet
        .mockResolvedValueOnce({ data: { mimeType: 'image/png' } }) // metadata
        .mockResolvedValueOnce(mockStream); // media stream

      const result = await service.downloadImage('fileId', 'photo.png', '/tmp');

      expect(result).toBe('/tmp/photo.png');
    });

    it('should export Google Docs file and return destPath', async () => {
      mockDriveFilesGet.mockResolvedValueOnce({
        data: { mimeType: 'application/vnd.google-apps.document' },
      });
      mockDriveFilesExport.mockImplementationOnce(
        (params, options, callback) => {
          if (callback)
            callback(null, {
              data: {
                on: jest.fn().mockImplementation(function (ev, cb) {
                  if (ev === 'end') cb();
                  return this;
                }),
                pipe: jest.fn(),
              },
            });
        },
      );

      const result = await service.downloadImage('fileId', 'doc.pdf', '/tmp');

      expect(result).toBe('/tmp/doc.pdf');
      expect(mockDriveFilesExport).toHaveBeenCalled();
    });
  });
});
