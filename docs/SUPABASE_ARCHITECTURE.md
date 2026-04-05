# Stock Life — Supabase 중앙 시세·실시간·오프라인 배당 설계

이 문서는 **모든 유저가 동일한 주가·뉴스 타임라인**을 보게 하고, **방치형 배당**을 서버 권위로 정산하기 위한 구조를 정리합니다. 클라이언트는 현재 `LocalStorage`로 저장하며, 이후 이 설계로 이전할 수 있습니다.

## 1. 목표

| 목표 | 설명 |
|------|------|
| 단일 진실 공급원 (SSOT) | 주가·뉴스·장 운영 시계는 **서버 한곳**에서만 진행 |
| 실시간 동기화 | 가격/뉴스 스트림을 Supabase Realtime으로 구독 |
| 오프라인 배당 | 유저가 접속하지 않은 동안의 **배당 적립분**을 재접속 시 서버가 합산 지급 |

## 2. 핵심 테이블 (예시)

### 2.1 `market_clock` (1행 또는 파티션 1개)

글로벌 시장 시계. **모든 클라이언트가 이 행을 구독**해 동일한 `game_minutes`, `session_day`, `is_open`을 본다.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | `uuid` PK | 고정 1행이면 `default` 단일 키도 가능 |
| `updated_at` | `timestamptz` | 서버 틱마다 갱신 |
| `session_day_index` | `int` | 게임 일자 |
| `game_minutes` | `int` | 540~930 등 |
| `is_market_open` | `bool` | 장중 여부 |
| `candle_index` | `int` | 당일 누적 봉 번호 (체이닝 트리거용) |
| `server_tick_at` | `timestamptz` | 마지막으로 공식 틱이 진행된 실시간 시각 |

**시계 진행**: Edge Function + `pg_cron` 또는 별도 **틱 워커**가 1초마다(또는 설계한 실시간 간격마다) 행을 갱신하고, 동시에 `prices`·`news_events`를 갱신.

### 2.2 `instrument_prices` (종목별 시세 스냅샷)

| 컬럼 | 타입 |
|------|------|
| `symbol` | `text` PK (`AAA`, `BBB`, `CCC`) |
| `price` | `numeric` |
| `open`, `high`, `low` | `numeric` (당일 또는 현재 봉) |
| `volatility_mod` | `numeric` |
| `price_bias` | `numeric` |
| `updated_at` | `timestamptz` |

필요 시 **봉 히스토리**는 `candles` 테이블로 분리 (`symbol`, `session_day`, `idx`, `o/h/l/c/v`).

### 2.3 `news_events` (공통 뉴스 로그)

| 컬럼 | 타입 |
|------|------|
| `id` | `bigserial` |
| `created_at` | `timestamptz` |
| `session_day_index` | `int` |
| `candle_index` | `int` |
| `kind` | `text` (`chain`, `calendar`, `ambient`, …) |
| `payload` | `jsonb` (헤드라인, impacts, bias, volFactor) |

클라이언트는 `news_events`를 **시간순 구독**해 피드에 표시. 체이닝 스케줄은 **서버만** 실행해 중복 발화 방지.

### 2.4 `profiles` / `user_portfolios`

| 테이블 | 용도 |
|--------|------|
| `profiles` | `user_id` (auth.users FK), 표시명 등 |
| `user_portfolios` | `user_id`, `cash`, `age`, `holdings jsonb`, `cost_basis jsonb` |

보유·현금은 **거래 시에만** RPC로 갱신해 변조를 줄인다.

### 2.5 `user_dividend_state` (방치 배당용)

오프라인 배당의 핵심: **마지막으로 배당을 정산한 서버 시각**을 저장한다.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `user_id` | `uuid` PK | |
| `last_dividend_settled_at` | `timestamptz` | 서버 기준으로 배당 누적을 마감한 시각 |
| `last_seen_market_tick_at` | `timestamptz` | 선택: 유저가 마지막으로 본 공식 틱 (감사용) |

## 3. 오프라인(방치) 배당 플로우

1. **서버**는 `market_clock.server_tick_at`을 단조 증가시키며, 장중일 때만 배당 누적에 사용할 **“공식 경과 시간”**을 정의한다.
2. 유저가 **로그인/재연결**할 때 RPC `claim_idle_dividends` 실행:
   - 입력: 없음 또는 `client_now` (검증용).
   - 서버는 `last_dividend_settled_at` ~ `now()` 구간을 **캡**(예: 7일)으로 자른다.
   - 그 구간 동안 **시장이 열려 있었던 틱 수** 또는 **단순화된 초 단위**를 `market_clock` 히스토리(또는 사전 정의된 스케줄)로부터 계산한다.
   - BBB/CCC 보유분에 대해 **현재 클라이언트와 동일한 금리식**으로 현금을 합산해 `user_portfolios.cash`에 가산.
   - `last_dividend_settled_at = now()`로 갱신.
3. **LocalStorage 단계**에서 쓰는 식(10초당 1회 배당 등가)은 서버에서도 동일 상수를 두어 **클라이언트 단독 플레이와 합산 결과가 유사**하게 맞출 수 있다. 최종 권위는 항상 서버.

## 4. 실시간 구독 (Supabase Realtime)

- `market_clock`: 단일 행 `UPDATE` 구독 → 상단 시계·장 상태 동기화.
- `instrument_prices`: `UPDATE` 구독 → 차트·관심종목.
- `news_events`: `INSERT` 구독 → 뉴스 피드.

**보안**: `anon` 키는 RLS로 **시세/뉴스는 전부 읽기**, 포트폴리오는 `auth.uid()` 본인만 읽기/쓰기.

## 5. Edge Functions / RPC 역할

| 기능 | 구현 |
|------|------|
| 시장 틱 | 전용 워커 또는 Edge + 큐 (1초 틱) |
| 매수/매도 | RPC: 가격·현금·수량 검증 후 `user_portfolios` 갱신 |
| 배당 청구 | RPC `claim_idle_dividends` |
| 체이닝 뉴스 | 틱 워커가 `candle_index`와 스케줄표로 `news_events` INSERT만 수행 |

## 6. 클라이언트 마이그레이션 순서

1. Supabase Auth 도입 (익명 로그인으로 시작 가능).
2. `market_clock` + `instrument_prices` Realtime 구독으로 **주가·시계만** 서버 전환.
3. 거래 RPC로 **포트폴리오** 이전, LocalStorage는 백업/오프라인 캐시로 축소.
4. `claim_idle_dividends`로 **방치 배당** 서버 권위화.
5. 뉴스·캔들 히스토리를 서버 데이터로 통일.

## 7. 참고: 현재 클라이언트와의 대응

- `LS_KEY` / `collectSavePayload()`에 들어 있는 필드는 위 `user_portfolios` + 스냅샷과 1:1 매핑하기 좋다.
- 오프라인 배당 `computeOfflineDividendAccrual`은 서버 RPC의 **단순화 버전**으로 유지할 수 있다.

## 8. 전역 리셋·친구 매매 알림 마이그레이션

배포 시 `supabase/migrations/20260406120000_world_reset_social_orderbook.sql`을 적용하면 다음이 반영된다.

- 모든 유저 `cash` / `initial_capital`을 **1천만원**으로 맞추고 `portfolios`를 비운다(기존 `trade_logs`·`assets` 테이블이 있으면 DROP).
- `social_trade_events` 테이블 + Realtime INSERT 구독으로 **풀매수(가용 현금의 90% 이상 단일 매수)** / **풀매도(전량 매도)** 시 친구에게 알림.
- 선택 RPC `reset_world_if_token`으로 동일 초기화를 토큰 문자열로 재실행 가능(토큰은 SQL 내 문자열을 배포 전에 변경할 것).

클라이언트는 `?clearLocal=1` 쿼리로 `localStorage` 튜토리얼 플래그·`sessionStorage` 로그인 이름을 한 번 비울 수 있다.
