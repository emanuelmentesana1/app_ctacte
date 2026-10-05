-- Migration 056 — Rendir el efectivo de la hoja en la app (05/10/2026). Idempotente.
--
-- Etapa 2 del diseño de rendiciones que aprobó Mati el 04/10/2026. Hoy Anto tipea en el escritorio
-- de InfoManager unos 19 recibos de efectivo por día, al día siguiente del reparto, desde el papel
-- de la hoja. Con esto la oficina carga en la app lo cobrado por cliente, los gastos del viaje y el
-- efectivo contado, y la app emite los recibos a Caja Repartos con el motor de Cobranzas.
--
-- Decisiones de Mati que viven acá:
--   · la rendición va POR HOJA;
--   · el efectivo lo cuenta Anto y lo controla Maca (otra persona). La diferencia NO se descuenta en
--     el momento: se acumula en un saldo mensual por repartidor (sale de `rendiciones.diferencia`);
--   · la app anota los gastos del viaje (la orden de pago en IM sigue a mano: la API no la crea).
--
-- Sin esta migración la app no se rompe: la rendición sigue en sólo lectura (etapa 1).
begin;

-- ── 1) El cobro sabe de qué hoja es ─────────────────────────────────────────────────────────────
-- También es la "opción A" de comisiones: queda registrado quién cobró y en qué hoja.
alter table comprobantes_pago add column if not exists hoja_id uuid references hojas_ruta(id);
create index if not exists comp_pago_hoja_idx on comprobantes_pago (hoja_id) where hoja_id is not null;

-- 🔑 Reclamo en base: UN recibo de efectivo por cliente y hoja. Si dos personas emiten la misma hoja
-- a la vez, la segunda choca acá y no llega a InfoManager (el candado en memoria de aprobarRecibo
-- cuida un recibo; éste cuida que no se creen dos).
create unique index if not exists comp_pago_hoja_efectivo_uidx
  on comprobantes_pago (hoja_id, cod_cliente)
  where hoja_id is not null and medio_pago = 'efectivo';

comment on column comprobantes_pago.hoja_id is
  'Hoja de ruta a la que pertenece el cobro. La rendición de la hoja emite el efectivo con este vínculo (no por fecha: hay hojas con la fecha corrida un día).';

-- ── 2) La rendición de cada hoja ────────────────────────────────────────────────────────────────
create table if not exists rendiciones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  hoja_id uuid not null references hojas_ruta(id) on delete cascade,
  -- Lo cobrado en efectivo por cliente, como figura en el papel de la hoja: [{cod_cliente, importe}].
  efectivo jsonb not null default '[]'::jsonb check (jsonb_typeof(efectivo) = 'array'),
  -- Gastos del viaje: [{concepto, importe, detalle}]. La OP en IM se carga a mano con este texto.
  gastos jsonb not null default '[]'::jsonb check (jsonb_typeof(gastos) = 'array'),
  -- Lo que llegó a la oficina. NULL = todavía no se contó (no es lo mismo que $0).
  efectivo_contado numeric(14,2) check (efectivo_contado is null or efectivo_contado >= 0),
  -- contado − (efectivo − gastos). Negativa: faltó plata · positiva: sobró. Suma al saldo del mes.
  diferencia numeric(14,2),
  contado_por uuid references usuarios(id),
  contado_at timestamptz,
  -- Lo controla otra persona que la que contó (la app lo exige).
  controlado_por uuid references usuarios(id),
  controlado_at timestamptz,
  observaciones text check (observaciones is null or length(observaciones) <= 500),
  -- Dos personas con la misma rendición abierta: la segunda que guarda recibe "recargá", no pisa.
  version int not null default 1,
  updated_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists rendiciones_hoja_uidx on rendiciones (tenant_id, hoja_id);

-- RLS: sólo service_role, igual que el resto de la app (el permiso lo controla el server con el JWT).
alter table rendiciones enable row level security;
drop policy if exists rendiciones_service on rendiciones;
create policy rendiciones_service on rendiciones for all to service_role using (true) with check (true);

-- set_updated_at() existe desde la migración 032.
drop trigger if exists rendiciones_updated_at on rendiciones;
create trigger rendiciones_updated_at before update on rendiciones
  for each row execute function set_updated_at();

commit;
