export interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
  price: number | null;
  pnl: number | null;
  liquidity: number | null;
  marketCap: number | null;
  // Lifecycle validation fields
  lifecycleStage?:
    | "pump_fun_bonding"
    | "graduated_no_pool"
    | "graduated_zero_liquidity"
    | "fully_tradable"
    | "unknown";
  lifecycleValidated?: boolean;
  isTradable?: boolean;
  hasGraduated?: boolean;
  hasLiquidity?: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
  isPumpFun?: boolean;
}
