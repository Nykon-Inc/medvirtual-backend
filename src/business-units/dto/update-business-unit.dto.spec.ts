import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateBusinessUnitDto } from './update-business-unit.dto';

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateBusinessUnitDto, payload);
  return validate(dto);
}

describe('UpdateBusinessUnitDto', () => {
  it('accepts valid app-branding fields', async () => {
    const errors = await validateDto({
      primary_color: '#077999',
      primary_hover: '#066685',
      logo_url: 'https://staging.medvirtual.ai/logo.png',
      favicon_url: 'https://staging.medvirtual.ai/favicon.ico',
      candidate_pool: 'non_medical',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts a 3-digit hex color', async () => {
    const errors = await validateDto({ primary_color: '#fff' });
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid primary_color', async () => {
    const errors = await validateDto({ primary_color: 'not-a-color' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('primary_color');
  });

  it('rejects an invalid primary_hover', async () => {
    const errors = await validateDto({ primary_hover: 'blue' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('primary_hover');
  });

  it('rejects an invalid candidate_pool', async () => {
    const errors = await validateDto({ candidate_pool: 'everyone' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('candidate_pool');
  });

  it('accepts "medical" and "non_medical" candidate_pool values', async () => {
    expect(await validateDto({ candidate_pool: 'medical' })).toHaveLength(0);
    expect(await validateDto({ candidate_pool: 'non_medical' })).toHaveLength(
      0,
    );
  });
});
