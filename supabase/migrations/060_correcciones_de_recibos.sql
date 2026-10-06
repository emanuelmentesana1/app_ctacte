-- Migration 060 — Registro de las correcciones en IM de recibos ya emitidos (06/10/2026). Idempotente.
--
-- Mati (06/10/2026), por MONTENORT: cambió en la app el medio de pago de dos recibos creyendo que así se corregía
-- InfoManager, y en IM siguieron en la cuenta vieja. Desde ahora un recibo ya emitido se corrige EN IM desde la app
-- («Corregir en IM»): si sólo cambia la cuenta, se edita el recibo en IM5 y conserva el número; si cambia el monto,
-- el cliente o la fecha, se anula y se reemite. Sólo admin o gerente, con confirmación y con este registro.
--
-- Cada fila es UNA corrección: qué había (antes), qué quedó (después), quién la hizo y cómo terminó. Si IM no
-- confirma el cambio, queda en 'error' con el motivo: nunca se pierde lo que se intentó.
--
-- Sin esta migración la app no corrige nada en IM: lo dice y no toca InfoManager.
begin;

create table if not exists recibos_correcciones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  comprobante_id uuid not null references comprobantes_pago(id),
  -- El recibo de IM que se corrigió (id interno de IM, el de comprobantes_pago.infomanager_recibo_id).
  im_recibo_id text not null,
  -- 'cuenta': editado en IM5 (mismo número) · 'anular_reemitir': anulado y emitido de nuevo.
  tipo text not null check (tipo in ('cuenta', 'anular_reemitir')),
  antes jsonb not null,
  despues jsonb,
  estado text not null default 'en_curso' check (estado in ('en_curso', 'hecha', 'error')),
  error text,
  por uuid not null references usuarios(id),
  created_at timestamptz not null default now(),
  terminada_at timestamptz
);

create index if not exists recibos_correcciones_comprobante_idx on recibos_correcciones (comprobante_id, created_at desc);

comment on table recibos_correcciones is
  'Correcciones en InfoManager de recibos que la app ya emitió (Mati, 06/10/2026): quién, cuándo, antes, después y cómo terminó.';

-- RLS: sólo service_role, igual que el resto de la app (el permiso lo controla el server con el JWT).
alter table recibos_correcciones enable row level security;
drop policy if exists recibos_correcciones_service on recibos_correcciones;
create policy recibos_correcciones_service on recibos_correcciones for all to service_role using (true) with check (true);

commit;
