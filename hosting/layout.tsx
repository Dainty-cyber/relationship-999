import type { Metadata } from 'next';
export const metadata: Metadata = {
  title: '遇见彼此 · 确定关系前的 99 / 999 问',
  description: '同一道问题，两份独立的答案。双方都提交后，再一起揭晓。',
  icons: { icon: '/favicon.svg' }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
