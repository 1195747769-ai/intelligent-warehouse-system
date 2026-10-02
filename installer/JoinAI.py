"""Join the two GitHub AI download parts; the existing installer handles installation."""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile

NAME = 'IntelligentWarehouse-AI-4B-Optional.zip'
BYTES = 2551491729
SHA256 = 'ff4e32fdca6d41fdf8cfb6a28a2820f6ccfc675c1b774ab4516863c48f3cd12a'


def join(parts, output, size, digest):
    if output.exists():
        with output.open('rb') as stream:
            if output.stat().st_size == size and hashlib.file_digest(stream, 'sha256').hexdigest() == digest:
                return output
        raise ValueError('Existing ZIP does not match; move it aside before retrying.')
    if sum(p.stat().st_size for p in parts) != size:
        raise ValueError('Download parts are incomplete; download both parts again.')
    if shutil.disk_usage(output.parent).free < size + 64 * 1024 * 1024:
        raise ValueError('At least 3 GB of free space is needed to join the AI package.')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.ai-join-', delete=False) as writer:
            temporary = Path(writer.name)
            checksum = hashlib.sha256()
            for part in parts:
                with part.open('rb') as source:
                    while block := source.read(8 * 1024 * 1024):
                        checksum.update(block)
                        writer.write(block)
            writer.flush()
            os.fsync(writer.fileno())
        if checksum.hexdigest() != digest:
            raise ValueError('AI package checksum failed; download both parts again.')
        if output.exists():
            raise ValueError('ZIP appeared during joining; leave it in place and retry.')
        temporary.rename(output)
        temporary = None
        return output
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def check():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        parts = [root / 'one', root / 'two']
        for path, raw in zip(parts, [b'hello', b' world']):
            path.write_bytes(raw)
        digest = hashlib.sha256(b'hello world').hexdigest()
        output = join(parts, root / 'ok.zip', 11, digest)
        assert output.read_bytes() == b'hello world'
        assert join(parts, output, 11, digest) == output
        for size, expected in [(10, digest), (11, '0' * 64)]:
            try:
                join(parts, root / 'bad.zip', size, expected)
            except ValueError:
                pass
            else:
                raise AssertionError('Broken parts were accepted')
        assert not (root / 'bad.zip').exists() and not list(root.glob('.ai-join-*'))
    print('PASS: joined bytes, existing good ZIP, size/hash rejection and partial cleanup.')


if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        check()
    else:
        root = Path(__file__).resolve().parent
        try:
            print(join([root / (NAME + '.part01'), root / (NAME + '.part02')], root / NAME, BYTES, SHA256))
        except (OSError, ValueError) as error:
            sys.exit('AI package could not be joined: ' + str(error))
