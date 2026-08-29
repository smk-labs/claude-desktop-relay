import { mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";

import { openssl } from "./openssl.ts";

/** How long a minted certificate is good for. Renewing is deleting the folder. */
const DAYS = "730";

/** A local certificate authority, and one leaf certificate signed by it. */
export type Authority = {
  /** Where the authority's own certificate sits, for NODE_EXTRA_CA_CERTS. */
  readonly caCertificatePath: string;
  /** The authority's certificate, as PEM. */
  readonly caCertificate: string;
  /** The leaf the relay presents for the host it opens. */
  readonly leaf: { readonly key: string; readonly cert: string };
  /** The host the leaf is good for. */
  readonly host: string;
};

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * A local authority and a leaf for `host`, in `directory`, minted once.
 *
 * Called again with the same arguments it reads what is already there, so the
 * certificate the machine has been told to trust does not change under it. To
 * renew, delete the directory.
 */
export async function ensureAuthority(directory: string, host: string): Promise<Authority> {
  const path = (name: string) => join(directory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const [caKey, caCert, leafKey, leafCert] = [path("ca.key"), path("ca.crt"), path("leaf.key"), path("leaf.crt")];

  if (!(await exists(caCert)) || !(await exists(caKey))) {
    await openssl([
      "req", "-x509", "-nodes", "-sha256", "-days", DAYS,
      "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", caKey, "-out", caCert,
      "-subj", "/CN=claude-desktop-relay local certificate authority",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
  }

  if (!(await exists(leafCert)) || !(await exists(leafKey))) {
    const request = path("leaf.csr");
    const extensions = path("leaf.ext");
    await writeFile(
      extensions,
      `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n` +
        `extendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host}\n`,
    );
    await openssl([
      "req", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", leafKey, "-out", request, "-subj", `/CN=${host}`,
    ]);
    await openssl([
      "x509", "-req", "-in", request, "-CA", caCert, "-CAkey", caKey,
      "-CAcreateserial", "-out", leafCert, "-days", DAYS, "-sha256",
      "-extfile", extensions,
    ]);
    await rm(request, { force: true });
    await rm(extensions, { force: true });
  }

  return {
    caCertificatePath: caCert,
    caCertificate: await readFile(caCert, "utf8"),
    leaf: { key: await readFile(leafKey, "utf8"), cert: await readFile(leafCert, "utf8") },
    host,
  };
}
