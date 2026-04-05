import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { advanceServerSecond } from "./engine.ts";

/**
 * 서비스 롤로 market_state 1행을 읽고 1초 시뮬레이션 스텝 후 저장합니다.
 * 배포 후 Cron(예: 1초마다) 또는 외부 스케줄러가 이 함수를 호출하세요.
 * 로컬: `supabase functions serve --no-verify-jwt`
 */
Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    return new Response(JSON.stringify({ ok: false, error: "Missing env" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(url, key);
  const { data: row, error: readErr } = await supabase
    .from("market_state")
    .select("state")
    .eq("id", 1)
    .maybeSingle();

  if (readErr) {
    return new Response(JSON.stringify({ ok: false, error: readErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const prev = (row?.state as Record<string, unknown> | null) ?? null;
  const state = advanceServerSecond(prev);

  const { error: writeErr } = await supabase.from("market_state").upsert({
    id: 1,
    state,
    updated_at: new Date().toISOString(),
  });

  if (writeErr) {
    return new Response(JSON.stringify({ ok: false, error: writeErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ ok: true, serverTick: state.serverTick, gameMinutes: state.gameMinutes }),
    { headers: { "Content-Type": "application/json" } },
  );
});
