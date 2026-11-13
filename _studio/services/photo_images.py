"""图片处理流水线：解码与方向校正、EXIF 时间、唯一命名及三级图像原子写入。"""
import os
import time
import uuid
from . import storage
from .photo_paths import BASE_IMAGE_DIR, THUMB_DIR, PREVIEW_DIR

try:
    from PIL import ExifTags, Image, ImageOps
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("  [ PHOTOS ] ⚠️ 未检测到 Pillow 库，图片处理功能受限 | Pillow not found")
else:
    from pillow_heif import register_heif_opener
    register_heif_opener()


def get_exif_datetime(file_data):
    """从图片二进制数据中读取 EXIF 拍摄时间，返回 (time_struct, timestamp) 或 None"""
    if not HAS_PIL:
        return None
    try:
        import io
        with Image.open(file_data if isinstance(file_data, (str, os.PathLike)) else io.BytesIO(file_data)) as img:
            exif_data = img.getexif()
            exif_details = exif_data.get_ifd(ExifTags.IFD.Exif)
        # Tag 36867 = DateTimeOriginal, 36868 = DateTimeDigitized, 306 = DateTime
        for tag_id in (36867, 36868, 306):
            raw = exif_details.get(tag_id) or exif_data.get(tag_id)
            if raw:
                try:
                    t_struct = time.strptime(str(raw).replace('\x00', '').strip(), '%Y:%m:%d %H:%M:%S')
                    timestamp = time.mktime(t_struct)
                    return (t_struct, timestamp)
                except (ValueError, TypeError, OverflowError):
                    continue
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f"  [ PHOTOS ] ⚠️ EXIF 读取失败，使用当前时间 | EXIF unavailable: {type(error).__name__}")
    return None


def write_generated(image, path, image_format=None, **options):
    """在内存中完整编码后原子落盘，不把半张衍生图发布到真源。"""
    import io
    image_format = image_format or Image.registered_extensions().get(os.path.splitext(path)[1].lower())
    if not image_format:
        raise ValueError('Unsupported image format')
    output = io.BytesIO()
    image.save(output, image_format, **options)
    storage.write_bytes(path, output.getvalue())


def open_upload_image(file_data):
    """解码上传原图并校正方向，识别失败时返回可操作的错误。"""
    import io
    try:
        with Image.open(io.BytesIO(file_data)) as source:
            return ImageOps.exif_transpose(source)
    except (OSError, ValueError, SyntaxError) as error:
        raise ValueError('无法读取图片，格式不支持或文件已损坏') from error


def new_upload_name(file_data, extension, need_convert, fallback_label=None):
    exif_result = get_exif_datetime(file_data)
    timestamp = exif_result[1] if exif_result else None
    taken_at = exif_result[0] if exif_result else time.strptime(fallback_label, '%Y%m%d_%H%M%S') if fallback_label else time.localtime()
    time_label = time.strftime('%Y%m%d_%H%M%S', taken_at)
    if exif_result:
        print(f"  [ PHOTOS ] 📅 使用 EXIF 拍摄时间 | Using EXIF date: {time_label}")
    else:
        print(f"  [ PHOTOS ] 📅 EXIF 不可用，使用当前时间 | Using current date: {time_label}")
    photo_id = str(uuid.uuid4())
    extension = '.avif' if need_convert else extension
    name = f"{time_label}_{photo_id.replace('-', '')}{extension}"
    return photo_id, name, timestamp


class ImagePipeline:
    """只接收经过校验的路径解析器，图像处理不依赖图库数据库。"""

    def __init__(self, media_path):
        self.media_path = media_path

    def prepare_directories(self, category, name):
        for directory in (BASE_IMAGE_DIR, THUMB_DIR, PREVIEW_DIR):
            os.makedirs(os.path.dirname(self.media_path(f'{directory}/{category}/{name}')), exist_ok=True)

    def generate_derivatives(self, image, category, stem):
        """上传与云端登记共用尺寸、质量和原子写入策略，保留各自的文件编号规则。"""
        paths = []
        for directory, extension, size, quality in (
                (THUMB_DIR, 'webp', 600, 80), (PREVIEW_DIR, 'avif', 2560, 70)):
            path = f'{directory}/{category}/{stem}.{extension}'
            with image.copy() as resized:
                resized.thumbnail((size, size))
                if extension == 'webp' and resized.mode in ('RGBA', 'P'):
                    with resized.convert('RGB') as converted:
                        write_generated(converted, self.media_path(path), 'WEBP', quality=quality)
                else:
                    write_generated(resized, self.media_path(path), extension.upper(), quality=quality)
            paths.append(path)
        return tuple(paths)

    def write_upload_images(self, file_data, category, name, need_convert, is_restore):
        path = f'{BASE_IMAGE_DIR}/{category}/{name}'
        if not HAS_PIL:
            storage.write_bytes(self.media_path(path), file_data)
            return path, path
        if need_convert:
            try:
                import pillow_avif
            except ImportError:
                # 某些 Pillow 版本自带 AVIF 支持，编码器由后续实际保存验证。
                print("  [ PHOTOS ] ℹ️ 使用 Pillow 内置编码器 | Using Pillow image codecs")
        with open_upload_image(file_data) as image:
            try:
                if need_convert or (is_restore and name.endswith('.avif')):
                    write_generated(image, self.media_path(path), 'AVIF', quality=70)
                else:
                    storage.write_bytes(self.media_path(path), file_data)
                return self.generate_derivatives(image, category, os.path.splitext(name)[0])
            except (OSError, ValueError, SyntaxError) as error:
                raise ValueError('图片处理失败，原有数据未改动，请检查图片与本机存储后重试') from error
