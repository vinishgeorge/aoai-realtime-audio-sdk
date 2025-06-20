import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Generic WebSocket Chat Client App",
  description: "A generic WebSocket chat client app.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/icon.svg" />
          <script
            dangerouslySetInnerHTML={{
              __html: `(() => { try { const t = localStorage.getItem('theme'); const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches; const theme = t || (prefers ? 'dark' : 'light'); if (theme && theme !== 'light') document.documentElement.classList.add(theme); } catch(e) {} })();`,
            }}
          />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
