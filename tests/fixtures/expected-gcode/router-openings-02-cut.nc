; Voisee insert generator v0.1
; Sheet: Deck
; Operation: cut; tool: 6.35 mm router bit
; 24 x 24 inch sheet; origin at lower left; Z zero at material surface
; Grain / flute direction: y; board thickness: 3 mm
; Fold allowance: none (panels cut to drawn size)
; ROUTER operation; 6.35 mm bit with radius compensation
G21 ; millimeters
G90 ; absolute positioning
G17 ; XY plane
G0 Z3
M3 S18000 ; spindle clockwise
G4 P2 ; allow spindle to reach speed

; 1: cut router-opening (Folded pocket 1)
G0 X138.775 Y122.175
G1 Z-3.2 F250
G1 X387.125 Y122.175 F800
G1 X387.125 Y265.225 F800
G1 X138.775 Y265.225 F800
G1 X138.775 Y122.175 F800
G0 Z3

; 2: cut router-deck-perimeter
G0 X73.025 Y73.025
G1 Z-3.2 F250
G1 X536.575 Y73.025 F800
G1 X536.575 Y536.575 F800
G1 X73.025 Y536.575 F800
G1 X73.025 Y73.025 F800
G0 Z3

M5
G0 X0 Y0
G0 Z3
M2
