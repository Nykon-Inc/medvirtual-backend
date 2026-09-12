import { Test, TestingModule } from '@nestjs/testing';
import { TextractService } from './textract.service';
import { Textract } from '@aws-sdk/client-textract';

jest.mock('@aws-sdk/client-textract', () => {
  return {
    Textract: jest.fn().mockImplementation(() => ({
      startDocumentTextDetection: jest.fn(),
      getDocumentTextDetection: jest.fn(),
    })),
  };
});

describe('TextractService', () => {
  let service: TextractService;
  let textractMock: jest.Mocked<Textract>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TextractService],
    }).compile();

    service = module.get<TextractService>(TextractService);

    textractMock = (Textract as jest.Mock).mock.results[0].value;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
