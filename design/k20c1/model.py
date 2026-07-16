# Honda K20C1 (Civic Type R FK8/FL5) — modelo de exhibición para MotorForge
# ==========================================================================
# FEATURE SPECIFICATION (mm) — provenance: [researched] / [standard] / [assumed]
#
# DATUMS
#   BORE=86, STROKE=85.9, ROD=139, DECK_H=212 (eje cigüeñal→deck)  [researched]
#   PITCH=94 (entre cilindros = entre apoyos)                       [assumed ~1.09·bore, típico K]
#   CRANK_Z=120 sobre la placa; +X = lado distribución/poleas, -X = volante,
#   +Y = admisión, -Y = escape/turbo                                [researched: headifold+TD04 en un lado]
#
# REGION A — bloque
#   aluminio open-deck: 4 camisas de pie Ø98 con foso de agua Ø96..Ø110 prof. 34 [researched: open deck + camisas]
#   falda profunda hasta CRANK_Z-30, raíl de cárter, 5 mamparos con apoyo Ø59    [researched: deep skirt refuerzo]
#   10 taladros de culata Ø9 ciegos (2 filas × 5)                                [standard: 10 pernos K]
#   boss de filtro de aceite y sensor de picado en cara -Y                       [researched: knock sensor en bloque]
# REGION B — tren alternativo (piezas móviles, emitidas por separado)
#   cigüeñal plano 0/180-180/0, 5 apoyos Ø55, muñequillas Ø48, contrapesos r55.5 [assumed journals típicos K]
#   biela 139 sección en I, pie Ø22, cabeza Ø48.1                                [researched long. biela]
#   pistón Ø85.4, 3 segmentos, vaciado bajo corona, plato con cavidad, bulón Ø22 [researched CR 9.8:1]
# REGION C — culata + headifold
#   culata 376×200×90 con valle de levas; colector de escape INTEGRADO que
#   converge a una brida única Ø110 en -Y (waterjacketed "headifold")            [researched]
#   4 lumbreras de admisión ovaladas en +Y; DI: raíl + 4 inyectores laterales    [researched: solo inyección directa]
#   bomba HP de gasolina en el extremo -X de la culata                           [researched, posición assumed]
# REGION D — distribución y tapa
#   tapa de cadena en +X con bulbos VTC en las levas y salida del cigüeñal       [researched: cadena + dual VTC]
#   2 levas Ø25 con 8 lóbulos c/u (fases orden 1-3-4-2), piñón VTC               [standard 16v DOHC]
#   tapa de balancines roja con 4 bobinas centrales y tapón de aceite            [researched: bobinas centrales]
# REGION E — admisión
#   plenum Ø84 en +Y bajo, 4 runners curvos Ø40, cuerpo de mariposa Ø64
#   en el extremo +X con codo hacia el intercooler (fuera de escena)             [assumed forma; DBW researched]
# REGION F — turbo (MHI TD04 mono-scroll, wastegate ELÉCTRICA)                   [researched]
#   caracola de turbina + cuello a la brida del headifold, CHRA, caracola de
#   compresor con entrada axial +X, actuador eléctrico, downpipe, líneas de aceite
# REGION G — bajos y accesorios
#   cárter de dos alturas con sumidero -X y tapón de vaciado; volante Ø250;
#   polea de cigüeñal Ø150 + correa (hull convexo) a bomba de agua y alternador  [assumed correa 3 puntos]
#   motor de arranque -Y con soporte; varilla de aceite +Y                       [assumed posiciones]
# Simplificaciones declaradas: sin dientes de corona en el volante, sin
# soportes de motor (va en banco), sin embrague, correa sin tensor.

from solidsight import *
import math

# ---------------------------------------------------------------- datums
BORE, STROKE, ROD, PITCH = 86.0, 85.9, 139.0, 94.0
THROW = STROKE / 2
DECK_H = 212.0
CRANK_Z = 120.0
DECK_Z = CRANK_Z + DECK_H            # 332
BLOCK_L, BLOCK_W = 376.0, 226.0      # ±188, ±113
BLOCK_BASE = CRANK_Z - 30.0          # 90 (falda profunda)
CYL_X = [-1.5 * PITCH, -0.5 * PITCH, 0.5 * PITCH, 1.5 * PITCH]   # -141..141
MAIN_X = [-2 * PITCH, -PITCH, 0.0, PITCH, 2 * PITCH]             # -188..188
HEAD_W, HEAD_H = 200.0, 90.0         # culata ±100, 332..422
HEAD_TOP = DECK_Z + HEAD_H           # 422
CAM_Z, CAM_Y = 434.0, 40.0
TURBO_Y = -208.0
TURBO_Z = DECK_Z + 40.0              # 372
EXIT_X = -5.0                        # eje de salida del headifold / turbo


def vprofile(sk, w):
    """Perfil vertical: sketch-x -> +Y, sketch-y -> +Z, espesor w centrado en X."""
    return sk.extrude(w).rotate(x=90).rotate(z=90).translate(-w / 2, 0, 0)


# ================================================================ REGION A: bloque
blk = rounded_box(BLOCK_L, BLOCK_W, DECK_Z - BLOCK_BASE, 6, vertical_only=True).translate(0, 0, BLOCK_BASE)
# cavidad del cárter (paredes extremas de 7, techo en CRANK_Z+78)
blk -= box(362, 170, 110).translate(0, 0, BLOCK_BASE - 2)
# mamparos interiores con apoyo de bancada (solapan 2 mm en paredes y suelo)
for mx in MAIN_X[1:4]:
    blk += box(12, 174, 108).translate(mx, 0, BLOCK_BASE - 2)
# camisas de pie (siamesas) desde el techo del cárter
for cx in CYL_X:
    blk += cylinder(h=136, d=BORE + 12).translate(cx, 0, DECK_Z - 136)
# recorte al envolvente (las camisas de los cilindros 1 y 4 sobresalían de las caras)
blk = blk & box(BLOCK_L, BLOCK_W, 400)
# apoyos de bancada Ø59 (atraviesan también las paredes extremas)
for mx in MAIN_X:
    blk -= cylinder(h=26, d=59).rotate(y=90).translate(mx - 13, 0, CRANK_Z)
# foso de agua open-deck alrededor de cada camisa
for cx in CYL_X:
    blk -= (cylinder(h=34, d=110) - cylinder(h=36, d=96).translate(0, 0, -1)).translate(cx, 0, DECK_Z - 32.5)
# cilindros
for cx in CYL_X:
    blk -= cylinder(h=152, d=BORE).translate(cx, 0, DECK_Z - 151)
# taladros de culata Ø9 ciegos (2×5)
for hx in [-183, -PITCH, 0, PITCH, 183]:
    for hy in (-52, 52):
        blk -= parts.hole(9, 38, chamfer=0.5, drill_point=True).translate(hx, hy, DECK_Z)
# boss del filtro de aceite (-Y, hacia fuera) y boss del sensor de picado
blk += cylinder(h=22, d=60).rotate(x=90).translate(120, -109, 170)
blk += cylinder(h=14, d=26).rotate(x=90).translate(0, -111, 255)

# ================================================================ REGION B: internos
# --- cigüeñal (construido con eje X en z=0, luego subido a CRANK_Z)
crank = None
for mx in MAIN_X:
    j = cylinder(h=21, d=55).rotate(y=90).translate(mx - 10.5, 0, 0)
    crank = j if crank is None else crank + j
web2d = (circle(d=62).translate(0, THROW)
         + polygon([(-31, -2), (31, -2), (26, THROW), (-26, THROW)])
         + (circle(d=111) & rect(120, 55.5).translate(0, -27.75)))
web = vprofile(web2d, 25)
pin_phase = [0, 180, 180, 0]  # plano: 1 y 4 arriba, 2 y 3 abajo
for i, cx in enumerate(CYL_X):
    s = 1.0 if pin_phase[i] == 0 else -1.0
    crank += cylinder(h=27, d=48).rotate(y=90).translate(cx - 13.5, 0, s * THROW)
    w = web if s > 0 else web.rotate(x=180)
    crank += w.translate(cx - 25, 0, 0)
    crank += w.translate(cx + 25, 0, 0)
crank += cylinder(h=52, d=38).rotate(y=90).translate(196, 0, 0)     # morro
crank += cylinder(h=10, d=90).rotate(y=90).translate(-200, 0, 0)    # brida volante
crank = crank.translate(0, 0, CRANK_Z)

# --- biela (cabeza en el origen, pie en +139)
big_end = (cylinder(h=24, d=66) - cylinder(h=28, d=48.1).translate(0, 0, -2)).rotate(y=90).translate(-12, 0, 0)
small_end = (cylinder(h=20, d=34) - cylinder(h=24, d=22.1).translate(0, 0, -2)).rotate(y=90).translate(-10, 0, ROD)
shank2d = polygon([(-15, 26), (15, 26), (11, 124), (-11, 124)])
shank = vprofile(shank2d, 15)
pocket = vprofile(shank2d.offset(-4.5), 4.5)
shank = shank - pocket.translate(5.25, 0, 0) - pocket.translate(-5.25, 0, 0)
rod_proto = big_end + shank + small_end

# --- pistón (bulón en z=0 local, eje del bulón = X)
pis = cylinder(h=68, d=85.4).translate(0, 0, -38)
for gz in (24.0, 20.0, 16.0):
    pis -= (cylinder(h=1.6, d=88) - cylinder(h=3, d=80.5).translate(0, 0, -0.7)).translate(0, 0, gz - 0.8)
pis -= cylinder(h=3.2, d=58).translate(0, 0, 27.2)               # cavidad del plato
pis -= cylinder(h=58, d=70).translate(0, 0, -39)                 # vaciado bajo corona
pis -= box(95, 56, 36).translate(0, 0, -42)                      # ventanas de falda
pis += cylinder(h=24, d=34).rotate(y=90).translate(-36, 0, 0)    # boss bulón -X
pis += cylinder(h=24, d=34).rotate(y=90).translate(12, 0, 0)     # boss bulón +X
pis += cylinder(h=58, d=22).rotate(y=90).translate(-29, 0, 0)    # bulón
piston_proto = pis

PIN_Z_TDC = CRANK_Z + THROW + ROD    # 301.95
PIN_Z_BDC = CRANK_Z - THROW + ROD    # 216.05

# ================================================================ REGION C: culata + headifold
head = rounded_box(BLOCK_L, HEAD_W, HEAD_H, 8, vertical_only=True).translate(0, 0, DECK_Z)
head -= box(352, 124, 14).translate(8, 0, HEAD_TOP - 13)         # valle de levas
for cx in CYL_X:                                                  # lumbreras de admisión
    head -= rounded_box(44, 60, 28, 6, vertical_only=True).translate(cx, 72, 353)
# headifold: bulto convergente hacia la brida del turbo
head += hull(
    box(330, 12, 70).translate(0, -100, 342),
    cylinder(h=10, d=95).rotate(x=90).translate(EXIT_X, -138, TURBO_Z),
)
head += cylinder(h=8, d=110).rotate(x=90).translate(EXIT_X, -146, TURBO_Z)   # brida (solapa 2 con el bulto)
head -= cylinder(h=70, d=56).rotate(x=90).translate(EXIT_X, -90, TURBO_Z)    # conducto único

# --- levas (8 lóbulos c/u, fases del orden 1-3-4-2) + piñón VTC
def camshaft(exhaust):
    cam = cylinder(h=348, d=25).rotate(y=90).translate(-166, 0, 0)
    base = hull(cylinder(h=12, d=36), cylinder(h=12, d=14).translate(0, 14, 0)).rotate(y=90)
    fire = {0: 0, 1: 270, 2: 90, 3: 180}   # 1-3-4-2
    for i, cx in enumerate(CYL_X):
        for dx in (-17, 17):
            ang = fire[i] + (55 if exhaust else -55)
            cam += base.rotate(x=ang).translate(cx + dx - 6, 0, 0)
    cam += cylinder(h=6, d=46).rotate(y=90).translate(176, 0, 0)  # piñón VTC
    return cam

cam_in = camshaft(False).translate(0, CAM_Y, CAM_Z)
cam_ex = camshaft(True).translate(0, -CAM_Y, CAM_Z)

# ================================================================ REGION D: tapas
cover2d = polygon([(-113, BLOCK_BASE), (113, BLOCK_BASE), (113, 335), (100, 452), (-100, 452), (-113, 335)])
chain_cover = vprofile(cover2d, 14).translate(195, 0, 0)
chain_cover -= cylinder(h=30, d=58).rotate(y=90).translate(184, 0, CRANK_Z)          # paso del cigüeñal
chain_cover += cylinder(h=8, d=72).rotate(y=90).translate(200, CAM_Y, CAM_Z)         # bulbo VTC admisión
chain_cover += cylinder(h=8, d=72).rotate(y=90).translate(200, -CAM_Y, CAM_Z)        # bulbo VTC escape
chain_cover += cylinder(h=10, d=85).rotate(y=90).translate(200, 55, 290)             # bomba de agua
chain_cover += cylinder(h=20, d=76).rotate(y=90).translate(208, 55, 290)             # polea bomba

vcover = rounded_box(364, 148, 48, 10, vertical_only=True).translate(6, 0, HEAD_TOP)
vcover -= box(356, 132, 44).translate(6, 0, HEAD_TOP - 4)        # hueco interior (levas)
vcover += box(300, 6, 4).translate(6, 25, 469)                   # nervios
vcover += box(300, 6, 4).translate(6, -25, 469)
vcover += cylinder(h=10, d=38).translate(120, 42, 469)           # tapón de aceite

coils = None
for cx in CYL_X:
    c = cylinder(h=32, d=26).translate(cx, 0, 470) + box(30, 20, 12).translate(cx, 0, 500)
    coils = c if coils is None else coils + c

# ================================================================ REGION E: admisión
plenum = cylinder(h=320, d=84).rotate(y=90).translate(-155, 185, 302)
intake = plenum + box(340, 12, 60).translate(0, 106, 346)        # brida sobre las lumbreras
for cx in CYL_X:
    intake += parts.tube_path([(cx, 124, 368), (cx, 150, 372), (cx, 178, 340), (cx, 185, 312)], d=40)
intake += parts.tube_path([(-100, 60, 478), (-100, 76, 477), (-100, 135, 468),
                           (-100, 178, 404), (-100, 185, 344)], d=12)   # PCV
throttle = cylinder(h=8, d=78).rotate(y=90).translate(165.2, 185, 302)
throttle += cylinder(h=40, d=64).rotate(y=90).translate(173, 185, 302)
throttle += parts.tube_path([(213, 185, 302), (240, 185, 306), (252, 185, 326), (252, 185, 342)], d=56)
throttle += torus(28, 3).translate(252, 185, 342)                # abrazadera al intercooler

# --- raíl DI + inyectores + bomba HP
rail = box(300, 16, 16).translate(0, 135, 332)
for cx in CYL_X:
    rail += parts.tube_path([(cx, 135, 342), (cx, 106.5, 337.5)], d=10)
hp_pump = cylinder(h=40, d=36).rotate(y=-90).translate(-188, 30, 390)
hp_pump += cylinder(h=12, d=52).rotate(y=-90).translate(-188, 30, 390)
hp_pump += parts.tube_path([(-212, 42, 384), (-206, 95, 362), (-172, 128, 348), (-158, 135, 340)], d=8)

# ================================================================ REGION F: turbo TD04
turbo_hot = torus(30, 23).rotate(y=90).translate(EXIT_X, TURBO_Y, TURBO_Z)
turbo_hot += box(46, 44, 56).translate(EXIT_X, -176, 344)                      # cuello a la brida
turbo_hot += cone(h=45, d1=75, d2=62).rotate(y=-90).translate(EXIT_X - 20, TURBO_Y, TURBO_Z)
turbo_hot += cylinder(h=8, d=85).rotate(y=-90).translate(EXIT_X - 63, TURBO_Y, TURBO_Z)  # brida turbina
turbo_hot += rounded_box(48, 34, 26, 5).translate(EXIT_X, -170, 428)           # actuador eléctrico WG
turbo_hot += parts.tube_path([(EXIT_X, -178, 432), (EXIT_X, -200, 420)], d=8)  # varilla

turbo_core = cylinder(h=55, d=52).rotate(y=90).translate(18, TURBO_Y, TURBO_Z)
turbo_core += parts.tube_path([(45, TURBO_Y, 396), (45, TURBO_Y, 428), (45, -160, 428),
                               (45, -160, 300), (45, -117, 285)], d=6)         # engrase
turbo_core += parts.tube_path([(45, TURBO_Y, 348), (45, -160, 270), (45, -119.5, 250)], d=12)  # retorno

turbo_cold = torus(34, 26).rotate(y=90).translate(101, TURBO_Y, TURBO_Z)
turbo_cold += cone(h=40, d1=68, d2=58).rotate(y=90).translate(125, TURBO_Y, TURBO_Z)
turbo_cold += torus(30, 3).rotate(y=90).translate(165, TURBO_Y, TURBO_Z)       # boca de admisión
turbo_cold += parts.tube_path([(101, TURBO_Y, 398), (101, -170, 448), (101, -130, 458)], d=54)  # salida al IC
turbo_cold += torus(27, 3).rotate(x=-76).translate(101, -130, 458)

downpipe = cylinder(h=8, d=85).rotate(y=-90).translate(EXIT_X - 72.2, TURBO_Y, TURBO_Z)
downpipe += parts.tube_path([(-112, TURBO_Y, TURBO_Z), (-150, TURBO_Y, 335),
                             (-172, TURBO_Y, 240), (-172, TURBO_Y, 120)], d=60)

# ================================================================ REGION G: bajos y accesorios
pan = rounded_box(376, 230, 8, 6, vertical_only=True).translate(0, 0, 82)
pan += rounded_box(376, 226, 56, 6, vertical_only=True).translate(0, 0, 28)
pan += rounded_box(180, 226, 30, 6, vertical_only=True).translate(-98, 0, 0)
pan -= box(366, 216, 60).translate(0, 0, 33)
pan -= box(170, 216, 30).translate(-98, 0, 5)
pan += cylinder(h=10, d=22).rotate(x=90).translate(-98, -109, 14)     # tapón de vaciado
pan += prism(6, 6, across_flats=13).rotate(x=90).translate(-98, -118, 14)

flywheel = cylinder(h=30, d=250)
flywheel -= parts.bolt_circle(parts.hole(12, 34), 6, 60)
flywheel -= cylinder(h=34, d=30).translate(0, 0, -2)
flywheel = flywheel.chamfer_rim(3).rotate(y=90).translate(-230, 0, CRANK_Z)

pulley = (cylinder(h=24, d=150) - cylinder(h=28, d=38.4).translate(0, 0, -2))
pulley -= (cylinder(h=3, d=154) - cylinder(h=5, d=136).translate(0, 0, -1)).translate(0, 0, 6)
pulley -= (cylinder(h=3, d=154) - cylinder(h=5, d=136).translate(0, 0, -1)).translate(0, 0, 14)
pulley = pulley.rotate(y=90).translate(206, 0, CRANK_Z)

alt = cylinder(h=82, d=105).rotate(y=90).translate(130, 170, 200)
alt += cylinder(h=20, d=70).rotate(y=90).translate(208, 170, 200)
alt += box(30, 24, 46).translate(150, 126, 190)                       # pata al bloque

def belt_disc(y, z, r, h, x0):
    return cylinder(h=h, r=r).rotate(y=90).translate(x0, y, z)

belt = hull(belt_disc(0, CRANK_Z, 82, 8, 214), belt_disc(55, 290, 45, 8, 214), belt_disc(170, 200, 42, 8, 214))
belt -= hull(belt_disc(0, CRANK_Z, 75, 14, 211), belt_disc(55, 290, 38, 14, 211), belt_disc(170, 200, 35, 14, 211))

oil_filter = cylinder(h=70, d=78).rotate(x=90).translate(120, -131.5, 170)
oil_filter += cylinder(h=4, d=70).rotate(x=90).translate(120, -200.5, 170)

starter = cylinder(h=100, d=66).rotate(y=90).translate(-130, -150, 150)
starter += cylinder(h=70, d=40).rotate(y=90).translate(-115, -150, 196)
starter += box(60, 36, 20).translate(-80, -131.2, 160)

dipstick = parts.tube_path([(170, 117, 240), (170, 122, 300), (166, 127, 395)], d=7)
dipstick += torus(9, 3).rotate(x=90).translate(166, 127, 404)

# ================================================================ emits
emit(blk, name="block", color="slate")
emit(head, name="head", color="gray")
emit(vcover, name="valve_cover", color="#b3202a")
emit(chain_cover, name="chain_cover", color="slate")
emit(pan, name="oil_pan", color="dark")
emit(crank, name="crankshaft", color="steel")
for i, cx in enumerate(CYL_X):
    up = pin_phase[i] == 0
    pz = PIN_Z_TDC if up else PIN_Z_BDC
    bz = CRANK_Z + (THROW if up else -THROW)
    emit(rod_proto.translate(cx, 0, bz), name=f"conrod_{i + 1}", color="steel")
    emit(piston_proto.translate(cx, 0, pz), name=f"piston_{i + 1}", color="light")
emit(cam_in, name="cam_intake", color="steel")
emit(cam_ex, name="cam_exhaust", color="steel")
emit(intake, name="intake_manifold", color="dark")
emit(throttle, name="throttle_body", color="steel")
emit(rail, name="fuel_rail", color="steel")
emit(hp_pump, name="hp_pump", color="steel")
emit(turbo_hot, name="turbo_hot", color="dark")
emit(turbo_core, name="turbo_core", color="steel")
emit(turbo_cold, name="turbo_cold", color="gray")
emit(downpipe, name="downpipe", color="dark")
emit(flywheel, name="flywheel", color="steel")
emit(pulley, name="crank_pulley", color="dark")
emit(alt, name="alternator", color="gray")
emit(belt, name="belt", color="dark")
emit(coils, name="ignition_coils", color="dark")
emit(oil_filter, name="oil_filter", color="clay")
emit(starter, name="starter", color="dark")
emit(dipstick, name="dipstick", color="amber")

# ---- intención de ajustes (holguras de diseño)
expect("piston_1", "block", clearance=(0.05, 2.0))
expect("conrod_1", "crankshaft", clearance=(0.005, 0.5))
expect("piston_2", "conrod_2", clearance=(0.005, 0.5))
expect("crankshaft", "block", clearance=(0.5, 5.0))
expect("piston_1", "head", clearance=(0.02, 3.0))
expect("head", "block", status="touching")
expect("valve_cover", "head", status="touching")
expect("oil_pan", "block", status="touching")
expect("cam_intake", "valve_cover", clearance=0.5)
expect("crankshaft", "oil_pan", clearance=1.0)
