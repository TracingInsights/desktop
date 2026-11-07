import { describe, test, expect } from 'bun:test';
import {
  detectAtlas,
  isBareSpritePath,
  sniffImageType,
  validatePet,
  validatePetJson
} from './pet-validate.mjs';
import {
  fakeDecodeImage,
  fakePng,
  fakeWebp,
  petJson
} from './data-test-helpers.mjs';
import { LIMITS } from './contract.mjs';

const validate = (fields, image) =>
  validatePet({
    petJsonBuf: petJson(fields),
    imageBuf: image,
    decodeImage: fakeDecodeImage
  });

describe('detectAtlas', () => {
  test('v1, v2 and integer-scaled sheets', () => {
    expect(detectAtlas(1536, 1872)).toEqual({
      version: 1,
      rows: 9,
      width: 1536,
      height: 1872,
      scale: 1
    });
    expect(detectAtlas(1536, 2288)).toMatchObject({
      version: 2,
      rows: 11,
      scale: 1
    });
    expect(detectAtlas(768, 936)).toMatchObject({ version: 1, scale: 0.5 });
    expect(detectAtlas(3072, 4576)).toMatchObject({ version: 2, scale: 2 });
  });

  test('wrong dimensions', () => {
    expect(detectAtlas(1536, 1873)).toBeNull();
    expect(detectAtlas(1537, 1872)).toBeNull();
    expect(detectAtlas(1536, 1536)).toBeNull();
    expect(detectAtlas(0, 0)).toBeNull();
    expect(detectAtlas(1.5, 2)).toBeNull();
    expect(detectAtlas('1536', 1872)).toBeNull();
    // Proportional but cells not on whole pixels: 8 × 9 does not divide.
    expect(detectAtlas(12, 14.625)).toBeNull();
  });
});

describe('sniffImageType', () => {
  test('magic bytes, not extensions', () => {
    expect(sniffImageType(fakePng(1, 1))).toBe('png');
    expect(sniffImageType(fakeWebp(1, 1))).toBe('webp');
    expect(sniffImageType(Buffer.from('GIF89a........'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(4))).toBeNull();
  });
});

describe('validatePetJson', () => {
  test('caps strings and strips control characters', () => {
    const r = validatePetJson(
      petJson({
        displayName: `A\u0007${'x'.repeat(200)}`,
        description: 'd'.repeat(1000)
      })
    );
    expect(r.ok).toBe(true);
    expect(r.petJson.displayName.length).toBe(LIMITS.displayNameChars);
    expect(r.petJson.displayName.startsWith('A x')).toBe(true);
    expect(r.petJson.description.length).toBe(LIMITS.descriptionChars);
  });

  test('falls back to id for displayName; rejects neither', () => {
    expect(
      validatePetJson(petJson({ displayName: undefined })).petJson.displayName
    ).toBe('test-pet');
    expect(
      validatePetJson(petJson({ displayName: '', id: undefined })).ok
    ).toBe(false);
  });

  test('rejects oversize, non-JSON, arrays', () => {
    expect(validatePetJson(Buffer.alloc(LIMITS.petJsonBytes + 1, 32)).ok).toBe(
      false
    );
    expect(validatePetJson(Buffer.from('{nope')).ok).toBe(false);
    expect(validatePetJson(Buffer.from('[]')).ok).toBe(false);
    expect(validatePetJson(null).ok).toBe(false);
  });

  test.each([
    '../x.png',
    'a/b.png',
    'a\\b.png',
    'x.gif',
    '',
    '.png',
    'C:x.png'
  ])('rejects spritesheetPath %p', (path) => {
    expect(validatePetJson(petJson({ spritesheetPath: path })).ok).toBe(false);
  });

  test('spriteVersionNumber must be 1 or 2', () => {
    expect(validatePetJson(petJson({ spriteVersionNumber: 3 })).ok).toBe(false);
    expect(
      validatePetJson(petJson({ spriteVersionNumber: 2 })).petJson
        .spriteVersionNumber
    ).toBe(2);
  });

  test('isBareSpritePath', () => {
    expect(isBareSpritePath('spritesheet.webp')).toBe(true);
    expect(isBareSpritePath('Sprite.PNG')).toBe(true);
  });
});

describe('validatePet', () => {
  test('v1 png, v2 webp and scaled sheets pass', () => {
    const v1 = validate({}, fakePng(1536, 1872));
    expect(v1).toEqual({
      ok: true,
      pet: {
        id: 'test-pet',
        displayName: 'Test Pet',
        description: 'A generated test pet.',
        spritesheetPath: 'spritesheet.png',
        ext: 'png',
        mime: 'image/png',
        atlas: { version: 1, rows: 9, scale: 1, width: 1536, height: 1872 }
      }
    });
    const v2 = validate(
      { spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2 },
      fakeWebp(1536, 2288)
    );
    expect(v2.ok && v2.pet.ext).toBe('webp');
    expect(validate({}, fakePng(768, 936)).pet.atlas.scale).toBe(0.5);
  });

  test('the sniffed type wins over the extension', () => {
    const r = validate({ spritesheetPath: 'sheet.png' }, fakeWebp(1536, 1872));
    expect(r.ok && r.pet.mime).toBe('image/webp');
  });

  test('wrong dimensions fail', () => {
    const r = validate({}, fakePng(1000, 1000));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('1000×1000');
  });

  test('oversize image fails', () => {
    expect(validate({}, fakePng(1536, 1872, LIMITS.imageBytes)).ok).toBe(false);
  });

  test('non-image bytes fail', () => {
    expect(
      validate({}, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')).ok
    ).toBe(false);
  });

  test('undecodable image fails (decoder returns null or throws)', () => {
    const png = fakePng(1536, 1872);
    expect(
      validatePet({
        petJsonBuf: petJson(),
        imageBuf: png,
        decodeImage: () => null
      }).ok
    ).toBe(false);
    expect(
      validatePet({
        petJsonBuf: petJson(),
        imageBuf: png,
        decodeImage: () => {
          throw new Error('boom');
        }
      }).ok
    ).toBe(false);
  });

  test('version mismatch fails', () => {
    const r = validate({ spriteVersionNumber: 2 }, fakePng(1536, 1872));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('version 2');
  });

  test('missing image fails', () => {
    expect(validate({}, null).ok).toBe(false);
  });
});
