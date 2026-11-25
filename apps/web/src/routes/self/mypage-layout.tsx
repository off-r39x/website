import { Outlet } from "react-router";
import { MypageNav } from "../../features/mypage/mypage-nav";
import { Sticker } from "../../presentation/decor/sticker";

// The Mypage local navigation (SPEC-050 17.2). It stays across the Mypage pages, also on Access Denied.
// The AuthGate of the self layout runs first: nothing here renders for a Guest.
// The navigation sits on the black band shared by every Mypage page (DESIGN 7.1: one ink surface and one element
// across a section edge per page); the note crosses its lower edge, 24px clear of the links (DESIGN 7.3).
export default function MypageLayout() {
  return (
    <>
      {/* pt-24 keeps the links clear of the Header logo hanging below the bar (DESIGN 8.3). */}
      <div className="surface-ink bleed pt-24 pb-12">
        <div className="relative">
          <MypageNav />
          <Sticker kind="note" tilt={6} size={48} className="absolute top-full left-1/2 mt-6" />
        </div>
      </div>
      <Outlet />
    </>
  );
}
