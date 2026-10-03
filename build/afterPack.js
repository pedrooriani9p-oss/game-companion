// Põe ícone e informações de versão no Game Companion.exe sem precisar do Wine (gera o .exe no Linux também).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const { productFilename } = ctx.packager.appInfo;
  const version = ctx.packager.appInfo.version;
  const exePath = path.join(ctx.appOutDir, `${productFilename}.exe`);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups.length ? groups[0].id : 1, lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [ma, mi, pa] = version.split('.').map(Number);
  vi.setFileVersion(ma, mi, pa, 0); vi.setProductVersion(ma, mi, pa, 0);
  const strings = { FileDescription: 'Game Companion', ProductName: 'Game Companion', CompanyName: 'Pedro Oriani', OriginalFilename: `${productFilename}.exe`, InternalName: 'Game Companion', FileVersion: version, ProductVersion: version, LegalCopyright: 'Pedro Oriani' };
  const langs = vi.getAllLanguagesForStringValues();
  (langs.length ? langs : [{ lang: 1033, codepage: 1200 }]).forEach((l) => vi.setStringValues(l, strings));
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};
