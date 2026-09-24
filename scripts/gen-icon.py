"""Genera el icono de la aplicacion (build/icon.ico + icon.png).

El motivo es un PISTON visto de lado, que es la pieza que mejor dice "motor de
combustion" con menos trazos, y sobre todo la unica que sigue siendo reconocible
a 16 px. Se dibuja con primitivas y se supermuestrea x4 para que los bordes
curvos salgan limpios al reducir.

    python scripts/gen-icon.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "build"

S = 1024          # lienzo final
SS = 4            # supermuestreo
L = S * SS

FONDO_ARR = (18, 22, 27)      # gris azulado muy oscuro (no negro puro)
FONDO_ABA = (11, 14, 18)
ACERO_CLARO = (196, 203, 209)
ACERO = (150, 159, 167)
ACERO_OSCURO = (96, 104, 112)
RANURA = (58, 64, 70)
FUEGO = (214, 106, 44)        # el unico color caliente: la cara de combustion
FUEGO_TENUE = (140, 66, 28)


def degradado_vertical(dib: ImageDraw.ImageDraw, caja, arriba, abajo) -> None:
    x0, y0, x1, y1 = caja
    alto = max(1, y1 - y0)
    for i in range(alto):
        t = i / alto
        color = tuple(round(a + (b - a) * t) for a, b in zip(arriba, abajo))
        dib.rectangle([x0, y0 + i, x1, y0 + i + 1], fill=color)


def dibujar(lienzo: Image.Image) -> None:
    d = ImageDraw.Draw(lienzo)
    r = round(L * 0.22)                      # esquina redondeada de la placa
    d.rounded_rectangle([0, 0, L - 1, L - 1], radius=r, fill=FONDO_ABA)
    placa = Image.new("RGB", (L, L), FONDO_ABA)
    degradado_vertical(ImageDraw.Draw(placa), (0, 0, L, L), FONDO_ARR, FONDO_ABA)
    mascara = Image.new("L", (L, L), 0)
    ImageDraw.Draw(mascara).rounded_rectangle([0, 0, L - 1, L - 1], radius=r, fill=255)
    lienzo.paste(placa, (0, 0), mascara)

    cx = L // 2
    ancho = round(L * 0.44)                  # anchura del piston
    izq, der = cx - ancho // 2, cx + ancho // 2

    corona_y = round(L * 0.17)               # cara de combustion
    falda_y = round(L * 0.60)                # final de la falda
    grosor_corona = round(L * 0.080)         # gordo: es lo unico que se ve a 16 px

    # Cara de combustion: el acento caliente, arriba del todo.
    d.rounded_rectangle(
        [izq, corona_y, der, corona_y + grosor_corona],
        radius=round(grosor_corona * 0.35), fill=FUEGO)
    d.rectangle([izq, corona_y + grosor_corona - round(L * 0.008),
                 der, corona_y + grosor_corona], fill=FUEGO_TENUE)

    # Cuerpo del piston, con degradado para que se lea metalico y no plano.
    cuerpo = (izq, corona_y + grosor_corona, der, falda_y)
    degradado_vertical(d, cuerpo, ACERO_CLARO, ACERO_OSCURO)

    # Ranuras de los segmentos: son lo que dice "esto es un piston" y no "un
    # rectangulo". DOS y bien separadas, no tres: a 16 px, tres se funden en una
    # mancha gris y el piston deja de leerse.
    hueco = round(L * 0.042)
    grosor_ranura = round(L * 0.026)
    y = corona_y + grosor_corona + hueco
    for _ in range(2):
        d.rectangle([izq, y, der, y + grosor_ranura], fill=RANURA)
        y += grosor_ranura + hueco

    # Bulon: el circulo oscuro que ancla la biela.
    rb = round(L * 0.085)
    cyb = round(L * 0.50)
    d.ellipse([cx - rb, cyb - rb, cx + rb, cyb + rb], fill=FONDO_ABA)
    d.ellipse([cx - rb, cyb - rb, cx + rb, cyb + rb], outline=ACERO_OSCURO,
              width=round(L * 0.012))

    # Biela saliendo en angulo: da movimiento y evita la simetria muerta. Gorda,
    # porque una biela fina desaparece al reducir.
    ancho_biela = round(L * 0.135)
    pie_x = cx + round(L * 0.125)
    pie_y = round(L * 0.835)
    d.line([(cx, cyb), (pie_x, pie_y)], fill=ACERO, width=ancho_biela)
    d.line([(cx, cyb), (pie_x, pie_y)], fill=ACERO_CLARO, width=round(ancho_biela * 0.28))

    # Muñequilla del cigüeñal en el pie de biela.
    rm = round(L * 0.072)
    d.ellipse([pie_x - rm, pie_y - rm, pie_x + rm, pie_y + rm], fill=ACERO_OSCURO)
    d.ellipse([pie_x - rm, pie_y - rm, pie_x + rm, pie_y + rm], outline=ACERO_CLARO,
              width=round(L * 0.010))


def main() -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    grande = Image.new("RGB", (L, L), FONDO_ABA)
    dibujar(grande)
    icono = grande.resize((S, S), Image.LANCZOS)

    png = DESTINO / "icon.png"
    icono.save(png)

    # .ico multi-tamaño: Windows escoge el que necesita en cada sitio (barra de
    # tareas, explorador, alt-tab). Sin los tamaños pequeños, Windows reduce el
    # de 256 y sale borroso.
    tam = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    icono.save(DESTINO / "icon.ico", format="ICO", sizes=tam)

    print(f"icon.png  {icono.size[0]}x{icono.size[1]}  -> {png}")
    print(f"icon.ico  {', '.join(str(s[0]) for s in tam)}  -> {DESTINO / 'icon.ico'}")


if __name__ == "__main__":
    main()
