// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/APP.md §1 (React Query for all async reads; dapp-kit providers)
// @spec       docs/RECON.md R1 (transport), R12 (pinned package versions)
// @rules      G6 G7 G9
// @depends    ./routes.tsx (T0.4) · ./config.ts (T0.4) · ./lib/suiClient.ts (T0.4)
// @facts      Provider order (outer → inner): QueryClientProvider →
// @facts        SuiClientProvider → WalletProvider → BrowserRouter → AppRoutes.
// @facts        dapp-kit's providers both depend on React Query being above them.
// @facts      ⚠ @mysten/dapp-kit 1.1.9 SuiClientProvider is typed to
// @facts        SuiJsonRpcClient and CANNOT take a SuiGrpcClient. It therefore
// @facts        runs on the verified JSON-RPC MIRROR (config.sui.jsonRpcUrl);
// @facts        everything the app reads itself goes through lib/suiClient.ts's
// @facts        SuiGrpcClient. (RECON R1)
// @facts      ⚠ The testnet fullnode's JSON-RPC endpoint is 404/removed — passing
// @facts        it to SuiClientProvider would silently break every wallet read.
// @facts      dapp-kit ships its own stylesheet: @mysten/dapp-kit/dist/index.css.
// @facts        It is imported BEFORE ./theme.css so our tokens win.
// @implements ReactDOM.createRoot(...).render(<providers><AppRoutes/></providers>)
// @forbidden  constructing a Sui client here — use lib/suiClient.ts (one factory)
// @forbidden  a canonical id or endpoint literal here — G7
// @invariant  1. ./theme.css is imported after the dapp-kit stylesheet.
// @invariant  2. React Query defaults do not auto-refetch on window focus (a demo
//                must not fire network on alt-tab, G6).
// @ac         docs/APP.md §7 A11
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';

import '@mysten/dapp-kit/dist/index.css';
import './theme.css';

import AppRoutes from './routes';
import { config } from './config';
import { registerAphoticEnokiWallets } from './session/enoki';

// Enoki zkLogin wallets are wallet-standard wallets. They MUST be registered
// before <WalletProvider> mounts, otherwise dapp-kit's autoConnect races the
// registry and the Google wallet is missing on first paint. No-op (never a
// throw) when Enoki is unconfigured, so the app still builds with an empty .env.
registerAphoticEnokiWallets();

const { networkConfig } = createNetworkConfig({
  testnet: { network: 'testnet', url: config.sui.jsonRpcUrl },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

const container = document.getElementById('root');
if (container === null) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
