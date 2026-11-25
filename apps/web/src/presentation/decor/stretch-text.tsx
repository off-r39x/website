import { cn } from "../components/ui/cn";

/**
 * Stretch type: one span per character with its own width (DESIGN 4.4). Latin letters and digits only, one per
 * viewport. The original word is the name of the whole; the per-character spans are hidden.
 */
export function StretchText({ text, className }: { text: string; className?: string }) {
  return (
    <span role="img" aria-label={text} className={cn("stretch", className)}>
      {Array.from(text).map((char, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the characters of a fixed word, in order
        <span key={index} aria-hidden="true">
          {char}
        </span>
      ))}
    </span>
  );
}
