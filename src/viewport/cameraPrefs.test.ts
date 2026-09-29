import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { rotateAbout } from './cameraPrefs';

describe('rotateAbout', () => {
  it('raises the camera for a positive elevation and keeps the pivot distance', () => {
    const cam = new PerspectiveCamera();
    cam.position.set(0, -100, 100);
    const target = new Vector3(0, 0, 0);
    const pivot = new Vector3(20, 10, 0);
    const d0 = cam.position.distanceTo(pivot);
    rotateAbout(cam, target, pivot, 0, 0.2);
    expect(cam.position.z).toBeGreaterThan(100);
    expect(cam.position.distanceTo(pivot)).toBeCloseTo(d0, 6);
  });
  it('turns around +Z for azimuth and preserves height', () => {
    const cam = new PerspectiveCamera();
    cam.position.set(0, -100, 50);
    const target = new Vector3(0, 0, 0);
    rotateAbout(cam, target, new Vector3(0, 0, 0), Math.PI / 2, 0);
    expect(cam.position.x).toBeCloseTo(100, 6);
    expect(cam.position.z).toBeCloseTo(50, 6);
  });
});
