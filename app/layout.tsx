import type { Metadata, Viewport } from "next";
// Self-hosted so the build never reaches the network for fonts, which would fail offline and in
// air-gapped CI. Bricolage Grotesque carries the interface; Source Serif is used for the transcript
// and nothing else.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/source-serif-4";
import "./globals.css";

export const metadata: Metadata = {
  title: "Realtime Voice Agent",
  description:
    "A live, interruptible voice conversation in the browser, on OpenAI's Realtime API with the samai-sdk voice runtime.",
};

export const viewport: Viewport = {
  // One per scheme, so the browser chrome matches the page in both themes rather than keeping the
  // dark colour while the page is light.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#EDF0F4" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1220" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}