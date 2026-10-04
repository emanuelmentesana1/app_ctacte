import { describe, it, expect } from 'vitest';
import { usuarioIMDelAprobador, esRechazoPorUsuario } from './usuarioReciboIM.js';

/** S32 · mejora 5 (Mati, 04/10/2026): el recibo entra a IM con el usuario de quien aprueba. */
describe('usuarioIMDelAprobador', () => {
    it('usa el login de IM de la persona', () => {
        expect(usuarioIMDelAprobador({ im_usuario: 'anto' }, 'matias')).toBe('anto');
    });
    it('sin login cargado (o vacío) usa el de la app', () => {
        expect(usuarioIMDelAprobador({ im_usuario: null }, 'matias')).toBe('matias');
        expect(usuarioIMDelAprobador({ im_usuario: '   ' }, 'matias')).toBe('matias');
        expect(usuarioIMDelAprobador(null, 'matias')).toBe('matias');
    });
    it('recorta espacios: IM compara el texto exacto', () => {
        expect(usuarioIMDelAprobador({ im_usuario: ' jorgelina ' }, 'matias')).toBe('jorgelina');
    });
});

describe('esRechazoPorUsuario', () => {
    it('🔑 reconoce el rechazo de IM por el usuario', () => {
        expect(esRechazoPorUsuario({ errores: [{ campo: 'usuario', mensajes: ['El usuario no existe'] }] })).toBe(true);
        expect(esRechazoPorUsuario({ mensaje: 'Validaciones: • El Usuario [anto] no es válido' })).toBe(true);
    });
    it('otros rechazos no: ahí reintentar con otro usuario no arregla nada', () => {
        expect(esRechazoPorUsuario({ errores: [{ campo: 'comprobantes', mensajes: ['importe mayor al saldo'] }] })).toBe(false);
        expect(esRechazoPorUsuario(null)).toBe(false);
        expect(esRechazoPorUsuario('timeout')).toBe(false);
    });
});
