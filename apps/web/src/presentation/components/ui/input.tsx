import type { ComponentProps } from "react";
import { cn } from "./cn";

// Visual values come from the .field class in src/styles/globals.css (DESIGN 8.9, SPEC-050 24.3).
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn("field w-24", className)} {...props} />;
}
