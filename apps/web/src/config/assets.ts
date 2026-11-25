// Visual asset slots (SPEC-050 24.3). A null slot makes the UI fall back to text.
// The logo is the supplied file (assets/images/logo.png, byte-identical copy in src/assets), used as is in the Header
// and the Home hero (docs/DESIGN.md 10): its alt lists the words written on the logo, which are the site name.

import { SITE_NAME } from "./site";

export type AssetSlot = {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
};

export const assets: { readonly logo: AssetSlot | null; readonly keyVisual: AssetSlot | null } = {
  logo: {
    src: new URL("../assets/logo.png", import.meta.url).href,
    alt: SITE_NAME,
    width: 1920,
    height: 1920,
  },
  keyVisual: null,
};
