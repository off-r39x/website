import { readBuildEnv } from "../../config/build-env";
import { isUiMockEnabled } from "../../config/ui-mock";
import { copy } from "../../presentation/copy/ja";

/** A small fixed label shown in UI mock mode only. Not part of any navigation, not interactive. */
export function MockModeBadge() {
  if (!isUiMockEnabled(readBuildEnv())) return null;
  return (
    <div className="chip pointer-events-none fixed bottom-2 left-2 z-30 bg-lemon">
      {copy.layout.mockBadge}
    </div>
  );
}
