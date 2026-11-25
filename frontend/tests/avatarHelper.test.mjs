import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const OUT = process.env.KSS_TEST_OUT;
const { getEmployeeAvatar, LOCAL_AVATARS } = require(join(OUT, 'avatarHelper.cjs'));

test('Employee Avatar Resolution Suite', async (t) => {
  await t.test('1. User-uploaded custom photo always takes precedence over default portraits', () => {
    // Akash (KSS2407013) uploads a custom base64 photo
    const base64Photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...custom-photo';
    const akashWithCustomPhoto = {
      id: 'kss2407013',
      employeeId: 'KSS2407013',
      fullName: 'Akash Kumar',
      profilePhotoUrl: base64Photo
    };

    assert.equal(
      getEmployeeAvatar(akashWithCustomPhoto),
      base64Photo,
      'Custom base64 photo must be returned instead of /avatars/akash.jpg'
    );

    // Koushik (KSS2407003) uploads Cloudinary photo
    const cloudinaryPhoto = 'https://res.cloudinary.com/kalpanaaa/image/upload/v12345/koushik_new.jpg';
    const koushikWithCloudinary = {
      id: 'kss2407003',
      employeeId: 'KSS2407003',
      fullName: 'D. Koushik',
      profilePhotoUrl: cloudinaryPhoto
    };

    assert.equal(
      getEmployeeAvatar(koushikWithCloudinary),
      cloudinaryPhoto,
      'Custom Cloudinary photo must be returned instead of /avatars/koushik.png'
    );

    // Unsplash preset photo selection
    const unsplashPhoto = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300';
    const empWithPreset = {
      id: 'kss2407001',
      employeeId: 'KSS2407001',
      fullName: 'Gaurav K.',
      profilePhotoUrl: unsplashPhoto
    };

    assert.equal(
      getEmployeeAvatar(empWithPreset),
      unsplashPhoto,
      'Unsplash preset avatar must be returned instead of /avatars/gaurav.jpeg'
    );
  });

  await t.test('2. Fallback to official local portraits when no custom photo is uploaded', () => {
    // Akash without custom upload
    assert.equal(
      getEmployeeAvatar({ employeeId: 'KSS2407013', fullName: 'Akash Kumar' }),
      '/avatars/akash.jpg'
    );

    // Default portrait string itself also falls back to local avatar
    assert.equal(
      getEmployeeAvatar({ employeeId: 'KSS2407013', fullName: 'Akash Kumar', profilePhotoUrl: '/avatars/akash.jpg' }),
      '/avatars/akash.jpg'
    );

    // Asbin
    assert.equal(
      getEmployeeAvatar({ employeeId: 'KSS2407004', fullName: 'Asbin S.' }),
      '/avatars/asbin.jpg'
    );
  });

  await t.test('3. Fallback to UI Avatars for unknown employees with no portrait', () => {
    const unknown = { employeeId: 'KSS9999999', fullName: 'New Hire' };
    const avatar = getEmployeeAvatar(unknown);
    assert.match(avatar, /ui-avatars\.com/, 'Unknown employee without portrait falls back to ui-avatars');
  });
});
