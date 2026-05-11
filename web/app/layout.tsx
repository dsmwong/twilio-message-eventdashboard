import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Twilio Messaging Event Dashboard",
  description: "Compare StatusCallback vs Event Streams for Twilio Programmable Messaging.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
