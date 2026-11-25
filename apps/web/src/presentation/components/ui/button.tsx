import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

// Visual values come from the .btn classes in src/styles/globals.css (DESIGN 8.1, SPEC-050 24.3).
// default = primary (candy, coral offset; one per screen), outline = secondary, ghost = quiet text action.
export const buttonVariants = cva("btn shrink-0", {
  variants: {
    variant: {
      default: "btn-primary",
      outline: "btn-secondary",
      ghost: "btn-ghost",
      link: "link",
    },
    size: {
      default: "",
      sm: "btn--compact",
      lg: "",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Button({
  className,
  variant,
  size,
  ...props
}: Omit<ButtonPrimitive.Props, "className"> & { className?: string } & VariantProps<
    typeof buttonVariants
  >) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
