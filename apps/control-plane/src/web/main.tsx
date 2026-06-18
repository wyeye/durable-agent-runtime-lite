import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'antd/dist/reset.css';
import './styles.css';
import { App } from './App.js';
import { IdentityProvider } from './auth/identity-context.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: {
          borderRadius: 6,
          colorPrimary: '#2364aa',
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <AntApp>
        <IdentityProvider>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </IdentityProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
