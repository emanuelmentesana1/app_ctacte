-- Migration 053 — PRODUCCIÓN PROPIA: L3 desde 10 y L4 desde 30 unidades surtidas (29/09/2026). Idempotente.
--
-- Mati: *"para lista 3: 10 unidades surtidas de la misma familia... y lista 4: 30 unidades surtidas
-- también"*, y aclarado: *"solo alimento balanceado de producción propia este cambio que te digo,
-- el resto queda igual"*.
--
-- LINEA PRODUCCION PROPIA SEMILLERO (subrubro "Semillero": ponedora, iniciador, terminador, cerdo,
-- lechón, caballo, incluidas las de San Juan). "Surtidas de la misma familia" = ámbito `linea`:
-- suman todos los artículos del subrubro.
--   ANTES:  L3 desde 30 unidades · L4 desde 50 unidades
--   AHORA:  L3 desde 10 unidades · L4 desde 30 unidades
-- L1 (libre) y L2 (promo general de 10 bultos) no cambian. Las marcas de mascotas tampoco.
--
-- Aplicado el 29/09/2026 con UPDATE directo, controlando que cada uno tocara exactamente una fila,
-- y verificado con `evaluarPedido` sobre artículos reales: 9 surtidas en L3 se frena, 10 pasan;
-- 29 en L4 se frena, 30 pasan; Flecky (control) sigue igual.
begin;

update listas_reglas
   set umbral = 10, updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Semillero'
   and cod_lista = 14 and condicion = 'min' and unidad = 'unidad' and ambito = 'linea'
   and umbral = 30;

update listas_reglas
   set umbral = 30, updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Semillero'
   and cod_lista = 15 and condicion = 'min' and unidad = 'unidad' and ambito = 'linea'
   and umbral = 50;

commit;
