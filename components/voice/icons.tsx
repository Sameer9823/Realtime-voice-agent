/**
 * Inline stroke icons.
 *
 * Hand-drawn on a 24×24 grid with a consistent 1.75 stroke so they sit together without optical
 * correction, and inlined rather than pulled from an icon package to keep the runtime dependency
 * count where it was. Every icon is `aria-hidden`: each one always sits beside a real text label or
 * inside a control that carries its own accessible name, so announcing them would only add noise.
 */

export interface IconProps {
  /** Rendered size in pixels. Defaults to 18, which matches the label height it sits beside. */
  size?: number;
  className?: string;
}

function Svg({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...(className ? { className } : {})}
    >
      {children}
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5a2.75 2.75 0 0 1 2.75 2.75v5.5a2.75 2.75 0 1 1-5.5 0V6.25A2.75 2.75 0 0 1 12 3.5Z" />
      <path d="M5.75 11.25a.9.9 0 0 1 1.8 0 4.45 4.45 0 0 0 8.9 0 .9.9 0 0 1 1.8 0 6.25 6.25 0 0 1-5.45 6.19v1.81a.9.9 0 0 1-1.8 0v-1.81A6.25 6.25 0 0 1 5.75 11.25Z" />
    </Svg>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.25 6.6V6.25A2.75 2.75 0 0 1 14.6 8.9v3.6" />
      <path d="M14.6 14.9a2.75 2.75 0 0 1-5.35-.65v-1.1" />
      <path d="M5.75 11.25a.9.9 0 0 1 1.8 0 4.45 4.45 0 0 0 6.6 3.9M16.45 11.25a.9.9 0 0 1 1.8 0 6.24 6.24 0 0 1-.55 2.5" />
      <path d="M12 17.45v2.8a.9.9 0 0 1-1.8 0v-1.85" />
      <path d="M4.5 3.9 19.5 20.1" />
    </Svg>
  );
}

export function PushToTalkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.2a6.4 6.4 0 0 1 6.4 6.4v1.1a6.4 6.4 0 0 1-12.8 0v-1.1A6.4 6.4 0 0 1 12 4.2Z" />
      <path d="M3.4 11.6a.9.9 0 0 1 1.8 0 6.8 6.8 0 0 0 5.9 6.76M20.6 11.6a.9.9 0 0 0-1.8 0 6.79 6.79 0 0 1-.24 1.75" />
      <path d="M12 18.4v2.1M8.9 20.5h6.2" />
    </Svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2.4" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2.2" />
      <path d="M15.25 5.6A2.1 2.1 0 0 0 13.4 4.5H6.6A2.1 2.1 0 0 0 4.5 6.6v6.8a2.1 2.1 0 0 0 1.1 1.85" />
    </Svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.2v9.9" />
      <path d="m8.1 10.6 3.9 3.9 3.9-3.9" />
      <path d="M4.9 16.4v1.9a1.6 1.6 0 0 0 1.6 1.6h11a1.6 1.6 0 0 0 1.6-1.6v-1.9" />
    </Svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.6 11.3 19.2 5.1c.7-.3 1.4.4 1.1 1.1l-6.2 14.6c-.3.7-1.4.5-1.5-.2l-1.9-6.5-6.5-1.9c-.7-.1-.9-1.2-.2-1.5Z" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.6 4.6 4.6L19 6.9" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.6 21 19.4H3L12 4.6Z" />
      <path d="M12 10.4v3.9" />
      <path d="M12 17.2h.01" />
    </Svg>
  );
}