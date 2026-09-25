import { isAvailableStage } from './stage-dictionary';

describe('isAvailableStage', () => {
  it.each(['261075105', '1087596819', 261075105])(
    'should return true for available stage %p',
    (stage) => {
      expect(isAvailableStage(stage)).toBe(true);
    },
  );

  it.each(['1172847191', '261173428', '261214844', '942502182', '', null])(
    'should return false for non-available stage %p',
    (stage) => {
      expect(isAvailableStage(stage)).toBe(false);
    },
  );
});
