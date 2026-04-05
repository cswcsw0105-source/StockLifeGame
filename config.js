/**
 * Supabase 연동 — Vercel·로컬 공통 (anon 키는 공개 전제, RLS로 보호)
 */
window.STOCK_LIFE_CONFIG = {
  supabaseUrl: "https://wlatwgxojjzcbpdngzma.supabase.co",
  supabaseAnonKey:
    "sb_publishable_YJG0FgPcpQqgV_gpqtX2Sg_0DyOS_Fg",
  /** 비우기 권장. `reset_world_if_token`과 동일 문자열일 때만 전역 DB 리셋 RPC 호출(개발용) */
  resetWorldToken: "",
};
