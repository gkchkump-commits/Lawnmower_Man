"""MediaPipe Face Mesh landmark index sets (478-point model with irises).

Naming convention used throughout the pack: **L / R are screen (viewer) left / right**,
i.e. "L" is the eye that appears on the left of the image (the subject's right eye).
"""

# Face oval, clockwise starting at the forehead top (10).
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
             400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
             54, 103, 67, 109]

# Lips. Each list runs from the screen-left corner to the screen-right corner.
LIPS_OUTER_UPPER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
LIPS_OUTER_LOWER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]
LIPS_INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
LIPS_INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
MOUTH_CORNER_INNER_L, MOUTH_CORNER_INNER_R = 78, 308
MOUTH_CORNER_OUTER_L, MOUTH_CORNER_OUTER_R = 61, 291

# Eyes (screen-left eye = subject's right eye). Lists run outer corner -> inner corner for L,
# inner -> outer for R so that both run left-to-right on screen.
EYE_L_UPPER = [33, 246, 161, 160, 159, 158, 157, 173, 133]
EYE_L_LOWER = [33, 7, 163, 144, 145, 153, 154, 155, 133]
EYE_R_UPPER = [362, 398, 384, 385, 386, 387, 388, 466, 263]
EYE_R_LOWER = [362, 382, 381, 380, 374, 373, 390, 249, 263]
IRIS_L = [468, 469, 470, 471, 472]   # center first
IRIS_R = [473, 474, 475, 476, 477]

# Eyebrows (upper edge then lower edge), screen-left / screen-right.
BROW_L = [70, 63, 105, 66, 107, 46, 53, 52, 65, 55]
BROW_R = [336, 296, 334, 293, 300, 285, 295, 282, 283, 276]

NOSE_TIP = 1
NOSE_BOTTOM = 2
NOSE_BRIDGE = 6
FOREHEAD_TOP = 10
CHIN = 152
JAW_ANGLE_L, JAW_ANGLE_R = 172, 397
CHEEK_EDGE_L, CHEEK_EDGE_R = 234, 454   # face oval at ear level

# Rigid upper-face points (forehead, temples, nose bridge, eye corners) used to align frames.
UPPER_RIGID = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 127, 356, 162, 389, 21, 251, 54, 284,
               103, 332, 67, 297, 109, 338, 33, 263, 133, 362, 234, 454, 93, 323]

# Upper-jaw points (nose + upper lip) used to align open-mouth frames to the neutral frame.
UPPER_JAW = [1, 2, 4, 5, 19, 94, 98, 327, 0, 37, 267, 39, 269, 164, 165, 391, 92, 322, 168, 6,
             197, 195, 129, 358, 49, 279, 48, 278, 203, 423, 61, 291]

# Lower face (jaw) points.
LOWER_JAW = [17, 84, 314, 181, 405, 91, 321, 146, 375, 152, 148, 377, 176, 400, 149, 378,
             150, 379, 136, 365, 172, 397, 58, 288, 200, 199, 175, 18, 83, 313, 201, 421]
