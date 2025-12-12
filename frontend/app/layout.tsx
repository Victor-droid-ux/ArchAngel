import "./globals.css";
import Navbar from "@components/layout/navbar";
import Footer from "@components/layout/footer";
import { Toaster } from "react-hot-toast";
import type { Metadata, Viewport } from "next";
import { SocketProvider } from "./providers/SocketProvider";
import { SolanaWalletProvider } from "./providers/WalletProvider";

export const metadata: Metadata = {
  title: "ArchAngel Bot – Solana Trading Dashboard",
  description:
    "Automated Solana meme coin trading assistant powered by Raydium DEX.",
  metadataBase: new URL("https://archangelbot.app"), // ✅ base for OpenGraph/Twitter images
  manifest: "/manifest.json",
  icons: {
    icon: [
      {
        url: "/icons/manifest-icon-192.maskable.png",
        type: "image/png",
        sizes: "192x192",
      },
      {
        url: "/icons/manifest-icon-512.maskable.png",
        type: "image/png",
        sizes: "512x512",
      },
    ],
    apple: [
      { url: "/icons/manifest-icon-192.maskable.png" },
      { url: "/icons/manifest-icon-512.maskable.png" },
    ],
  },
  openGraph: {
    title: "ArchAngel Bot",
    description:
      "Automated Solana meme coin trading assistant powered by Raydium DEX.",
    url: "https://archangelbot.app",
    siteName: "ArchAngel Bot",
    images: [
      {
        url: "/icons/manifest-icon-512.maskable.png",
        width: 512,
        height: 512,
        alt: "ArchAngel Bot Logo",
      },
    ],
    locale: "en_US",
    type: "website",
  },
};

// ✅ Move themeColor to viewport (new Next.js convention)
export const viewport: Viewport = {
  themeColor: "#111827",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Progressive Web App meta tags */}
        <meta name="application-name" content="ArchAngel Bot" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
      </head>

      <body className="min-h-screen flex flex-col bg-base-100 text-base-content transition-colors duration-300">
        <SolanaWalletProvider>
          <SocketProvider>
            <Navbar />

            <main className="flex-grow container mx-auto px-4 py-8">
              {children}
            </main>

            <Footer />

            <Toaster
              position="bottom-right"
              toastOptions={{
                className:
                  "bg-neutral text-neutral-content rounded-lg shadow-md",
                duration: 3000,
              }}
            />
          </SocketProvider>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
