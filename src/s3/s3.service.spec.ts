import { Test, TestingModule } from '@nestjs/testing';
import { S3Service } from './s3.service';

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((params) => ({ ...params })),
}));

jest.mock('fs');
jest.mock('mime-types');
jest.mock('uuid');

describe('S3Service', () => {
  let service: S3Service;

  beforeEach(async () => {
    jest.clearAllMocks();

    const { v4 } = require('uuid');
    v4.mockReturnValue('test-uuid');

    const fs = require('fs');
    fs.readFileSync.mockReturnValue(Buffer.from('file-content'));

    const mime = require('mime-types');
    mime.lookup.mockReturnValue('image/png');

    const module: TestingModule = await Test.createTestingModule({
      providers: [S3Service],
    }).compile();
    service = module.get<S3Service>(S3Service);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('uploadFile', () => {
    it('should upload file and return filename with uuid prefix and correct extension', async () => {
      mockS3Send.mockResolvedValueOnce({});

      const result = await service.uploadFile(
        '/tmp/foto.png',
        'foto.png',
        'my-bucket',
      );

      expect(result).toBe('test-uuid.png');
      expect(mockS3Send).toHaveBeenCalledTimes(1);
    });

    it('should use application/octet-stream when MIME type is not recognized', async () => {
      const mime = require('mime-types');
      mime.lookup.mockReturnValueOnce(false);
      mockS3Send.mockResolvedValueOnce({});

      await service.uploadFile('/tmp/file.bin', 'file.bin', 'my-bucket');

      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ ContentType: 'application/octet-stream' }),
      );
    });

    it('should pass correct bucket, key, and body to S3', async () => {
      mockS3Send.mockResolvedValueOnce({});

      await service.uploadFile('/tmp/doc.png', 'doc.png', 'target-bucket');

      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'target-bucket',
          Key: 'test-uuid.png',
          ContentType: 'image/png',
        }),
      );
    });

    it('should throw when S3Client.send rejects', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('S3 upload failed'));

      await expect(
        service.uploadFile('/tmp/foto.png', 'foto.png', 'my-bucket'),
      ).rejects.toThrow('S3 upload failed');
    });

    it('should read file content from localFilePath', async () => {
      mockS3Send.mockResolvedValueOnce({});
      const fs = require('fs');

      await service.uploadFile('/tmp/foto.png', 'foto.png', 'my-bucket');

      expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/foto.png');
    });
  });
});
