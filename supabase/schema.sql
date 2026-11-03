-- 길따라 식당지도 - Supabase 테이블
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.

-- 식당 (상가업소번호 기준으로 한 번만 저장)
create table if not exists public.restaurants (
  id              text primary key,          -- 상가업소번호 (bizesId)
  name            text not null,             -- 상호명
  branch          text,                      -- 지점명
  category_large  text,                      -- 업종 대분류 (음식)
  category_middle text,                      -- 업종 중분류 (한식, 일식 ...)
  category_small  text,                      -- 업종 소분류
  ksic            text,                      -- 표준산업분류명
  sido            text,                      -- 시도
  sigungu         text,                      -- 시군구
  adong           text,                      -- 행정동
  ldong           text,                      -- 법정동
  jibun_addr      text,                      -- 지번주소
  road_name       text,                      -- 도로명 (예: 서울특별시 강남구 테헤란로)
  road_addr       text,                      -- 도로명주소
  building        text,                      -- 건물명
  zip             text,                      -- 우편번호
  dong            text,                      -- 동
  floor           text,                      -- 층
  ho              text,                      -- 호
  lat             double precision not null,
  lon             double precision not null,
  updated_at      timestamptz not null default now()
);

create index if not exists restaurants_road_name_idx on public.restaurants (road_name);
create index if not exists restaurants_category_idx on public.restaurants (category_middle);

-- 도로 검색 기록 (도로 + 지역 + 골목길 포함 여부 단위)
create table if not exists public.road_searches (
  id                   text primary key,     -- 예: 테헤란로|서울특별시|false
  road                 text not null,
  region               text not null,
  include_side_streets boolean not null default false,
  road_lines           jsonb,                -- 지도에 그릴 도로 모양
  api_calls            integer,
  truncated            boolean not null default false,
  store_count          integer not null default 0,
  searched_at          timestamptz not null default now()
);

-- 어떤 검색에 어떤 식당이 나왔는지
create table if not exists public.road_search_restaurants (
  search_id     text not null references public.road_searches (id) on delete cascade,
  restaurant_id text not null references public.restaurants (id) on delete cascade,
  primary key (search_id, restaurant_id)
);

-- 보안: 외부(anon) 접근은 막고, 서버의 service_role 키로만 읽고 씁니다.
alter table public.restaurants enable row level security;
alter table public.road_searches enable row level security;
alter table public.road_search_restaurants enable row level security;
