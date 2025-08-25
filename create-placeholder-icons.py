from PIL import Image, ImageDraw
import os

def create_shield_icon(size):
    # Create a new image with transparent background
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Scale factor
    scale = size / 128
    
    # Shield shape coordinates (scaled)
    points = []
    # Create a simple shield shape
    center_x, center_y = size // 2, size // 2
    
    # Shield outline
    shield_points = [
        (center_x, int(10 * scale)),  # top
        (int(20 * scale), int(25 * scale)),  # top left
        (int(20 * scale), int(65 * scale)),  # left
        (center_x, int(118 * scale)),  # bottom
        (int(108 * scale), int(65 * scale)),  # right
        (int(108 * scale), int(25 * scale)),  # top right
    ]
    
    # Draw shield
    draw.polygon(shield_points, fill=(74, 144, 226, 255))  # #4A90E2
    
    # Inner rectangle
    rect_x1 = int(32 * scale)
    rect_y1 = int(35 * scale)
    rect_x2 = int(96 * scale)
    rect_y2 = int(85 * scale)
    draw.rounded_rectangle([rect_x1, rect_y1, rect_x2, rect_y2], 
                          radius=int(8 * scale), 
                          fill=(107, 182, 255, 230))  # #6BB6FF with alpha
    
    # Eye outline
    eye_center_x = center_x
    eye_center_y = int(60 * scale)
    eye_width = int(40 * scale)
    eye_height = int(20 * scale)
    
    draw.ellipse([eye_center_x - eye_width//2, eye_center_y - eye_height//2,
                  eye_center_x + eye_width//2, eye_center_y + eye_height//2],
                 fill=(255, 255, 255, 242))  # white with alpha
    
    # Eye center
    pupil_size = int(14 * scale)
    draw.ellipse([eye_center_x - pupil_size//2, eye_center_y - pupil_size//2,
                  eye_center_x + pupil_size//2, eye_center_y + pupil_size//2],
                 fill=(74, 144, 226, 255))  # #4A90E2
    
    # Eye reflection
    reflect_size = int(6 * scale)
    reflect_x = eye_center_x - int(6 * scale)
    reflect_y = eye_center_y - int(6 * scale)
    draw.ellipse([reflect_x - reflect_size//2, reflect_y - reflect_size//2,
                  reflect_x + reflect_size//2, reflect_y + reflect_size//2],
                 fill=(255, 255, 255, 153))  # white with alpha
    
    return img

# Create icons directory if it doesn't exist
os.makedirs('icons', exist_ok=True)

# Create icons
sizes = [16, 32, 48, 128]

for size in sizes:
    img = create_shield_icon(size)
    filename = f'icons/icon-{size}.png'
    img.save(filename)
    print(f'Created {filename}')

print('All icons created successfully!')
