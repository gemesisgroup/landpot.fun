import { describe, expect, it } from "vitest";
import { shipFacingByte } from "../../../../src/client/render/gl/passes/UnitPass";

/** Facing byte = atlas row * 2 + mirrored. Rows: right, down-right, down,
 *  up-right, up. Screen y points down. */
const face = (row: number, mirrored: boolean) => row * 2 + (mirrored ? 1 : 0);

describe("shipFacingByte", () => {
  it("picks a view for each of the eight headings", () => {
    expect(shipFacingByte(1, 0)).toBe(face(0, false)); // east
    expect(shipFacingByte(1, 1)).toBe(face(1, false)); // south-east
    expect(shipFacingByte(0, 1)).toBe(face(2, false)); // south
    expect(shipFacingByte(-1, 1)).toBe(face(1, true)); // south-west
    expect(shipFacingByte(-1, 0)).toBe(face(0, true)); // west
    expect(shipFacingByte(-1, -1)).toBe(face(3, true)); // north-west
    expect(shipFacingByte(0, -1)).toBe(face(4, false)); // north
    expect(shipFacingByte(1, -1)).toBe(face(3, false)); // north-east
  });

  it("snaps to the nearest heading", () => {
    expect(shipFacingByte(1, 0.3)).toBe(face(0, false));
    expect(shipFacingByte(1, 0.6)).toBe(face(1, false));
    expect(shipFacingByte(-0.2, -1)).toBe(face(4, false));
  });

  it("faces right when it hasn't moved", () => {
    expect(shipFacingByte(0, 0)).toBe(face(0, false));
  });
});
