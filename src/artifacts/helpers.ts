import { Decoder } from "cbor";
import { assert } from "solc-typed-ast";
import { toHexString } from "..";
import { HexString, PartialSolcOutput, UnprefixedHexString } from "./solc";

interface ContractMdStruct {
    // bzzr0 hash
    bzzr0?: HexString;
    // bzzr1 hash
    bzzr1?: HexString;
    // ipfs hash
    ipfs?: HexString;
    // The solc version was included after 0.5.x
    solc?: string;
    // Are experimental features enabled?
    experimental?: boolean;
}

function getAllStringsAfterPrefix(hay: string, prefix: string, expLen: number): string[] {
    const res: string[] = [];

    let off = hay.length;

    while (true) {
        off = hay.lastIndexOf(prefix, off - 1);

        if (off === -1) {
            return res;
        }

        if (off + prefix.length + expLen >= hay.length) {
            continue;
        }

        res.push(hay.slice(off + prefix.length, off + prefix.length + expLen));
    }
}

function getAllBuffersAfterPrefix(hay: Buffer, prefix: Buffer, expLen: number): Buffer[] {
    const res: Buffer[] = [];

    let off = hay.length;

    while (true) {
        off = hay.lastIndexOf(prefix, off - 1);

        if (off === -1) {
            return res;
        }

        if (off + prefix.length + expLen >= hay.length) {
            continue;
        }

        res.push(hay.slice(off + prefix.length, off + prefix.length + expLen));
    }
}

const ipfsStrPrefix = "64697066735822";
const ipfsBufPrefix = Buffer.from(ipfsStrPrefix, "hex");
const bzzr0 = "65627a7a72305820";
const bzzr0BufPrefix = Buffer.from(bzzr0, "hex");
const bzzr1 = "65627a7a72315820";
const bzzr1BufPrefix = Buffer.from(bzzr1, "hex");

function getBytecodeHashHacky(bytecode: string | Buffer): ContractMdStruct | undefined {
    if (typeof bytecode === "string") {
        const ipfsCandidates = new Set(getAllStringsAfterPrefix(bytecode, ipfsStrPrefix, 34));
        const bzzr0Candidates = new Set(getAllStringsAfterPrefix(bytecode, bzzr0, 32));
        const bzzr1Candidates = new Set(getAllStringsAfterPrefix(bytecode, bzzr1, 32));

        if (ipfsCandidates.size + bzzr0Candidates.size + bzzr1Candidates.size !== 1) {
            return undefined;
        }

        if (ipfsCandidates.size === 1) {
            return { ipfs: [...ipfsCandidates][0] };
        } else if (bzzr0Candidates.size === 1) {
            return { bzzr0: [...bzzr0Candidates][0] };
        } else {
            return { bzzr1: [...bzzr1Candidates][0] };
        }
    } else {
        const ipfsCandidates = new Set(getAllBuffersAfterPrefix(bytecode, ipfsBufPrefix, 34));
        const bzzr0Candidates = new Set(getAllBuffersAfterPrefix(bytecode, bzzr0BufPrefix, 32));
        const bzzr1Candidates = new Set(getAllBuffersAfterPrefix(bytecode, bzzr1BufPrefix, 32));

        if (ipfsCandidates.size + bzzr0Candidates.size + bzzr1Candidates.size !== 1) {
            return undefined;
        }

        if (ipfsCandidates.size === 1) {
            return { ipfs: "0x" + [...ipfsCandidates][0].toString("hex") };
        } else if (bzzr0Candidates.size === 1) {
            return { bzzr0: "0x" + [...bzzr0Candidates][0].toString("hex") };
        } else {
            return { bzzr1: "0x" + [...bzzr1Candidates][0].toString("hex") };
        }
    }
}

function getDeployedBytecodeMdInfo(
    deployedBytecode: UnprefixedHexString | Buffer
): ContractMdStruct {
    const len = deployedBytecode.length;

    let rawMd: any = {};

    try {
        if (typeof deployedBytecode === "string") {
            const off = parseInt(deployedBytecode.substring(len - 4), 16);
            const mdHex = deployedBytecode.substring(len - 4 - off * 2, len - 4);

            rawMd = Decoder.decodeAllSync(mdHex, { encoding: "hex" })[0];
        } else {
            const off = deployedBytecode.readInt16BE(deployedBytecode.length - 2);

            rawMd = Decoder.decodeAllSync(
                deployedBytecode.slice(
                    deployedBytecode.length - 2 - off,
                    deployedBytecode.length - 2
                ),
                {}
            )[0];
        }
    } catch {
        // The contract bytecode may not have metadata, which would result in random crashes in the decoder.
        // Catch those so we don't end up crashing in the absence of metadata.
    }

    const res: ContractMdStruct = {};

    if (rawMd.hasOwnProperty("ipfs")) {
        res.ipfs = toHexString(rawMd.ipfs);
    }

    if (rawMd.hasOwnProperty("bzzr0")) {
        res.bzzr0 = toHexString(rawMd.bzzr0);
    }

    if (rawMd.hasOwnProperty("bzzr1")) {
        res.bzzr1 = toHexString(rawMd.bzzr1);
    }

    if (rawMd.hasOwnProperty("experimental")) {
        res.experimental = rawMd.experimental;
    }

    if (rawMd.hasOwnProperty("solc")) {
        res.solc = `${rawMd.solc[0]}.${rawMd.solc[1]}.${rawMd.solc[2]}`;
    }

    return res;
}

export function getCodeHash(deplBytecode: UnprefixedHexString | Buffer): HexString | undefined {
    const md = getDeployedBytecodeMdInfo(deplBytecode);

    // TODO: Should we prefix the hash with the hash type? bzzr0/ipfs
    if (md.bzzr0 !== undefined) {
        return md.bzzr0;
    }

    if (md.bzzr1 !== undefined) {
        return md.bzzr1;
    }

    if (md.ipfs !== undefined) {
        return md.ipfs;
    }

    return undefined;
}

export function getCreationCodeHash(
    creationBytecode: UnprefixedHexString | Buffer
): HexString | undefined {
    const md = getBytecodeHashHacky(creationBytecode);

    if (md === undefined) {
        return undefined;
    }

    // TODO: Should we prefix the hash with the hash type? bzzr0/ipfs
    if (md.bzzr0 !== undefined) {
        return md.bzzr0;
    }

    if (md.ipfs !== undefined) {
        return md.ipfs;
    }

    return undefined;
}

/**
 * Given a standard solc JSON output `artifact` find the compiler version used
 * to compute the contracts.  We do this by walking over all of the bytecodes in
 * the artifact, and decoding the CBOR-encoded metadata at the end of each
 * contract. If all contracts in the artifact agree on the version they report,
 * we return that.
 */
export function getArtifactCompilerVersion(artifact: PartialSolcOutput): string | undefined {
    let res: string | undefined;

    for (const fileName in artifact.contracts) {
        for (const contractName in artifact.contracts[fileName]) {
            const version = getDeployedBytecodeMdInfo(
                artifact.contracts[fileName][contractName].evm.deployedBytecode.object
            ).solc;

            assert(
                !(version !== undefined && res !== undefined && version !== res),
                `Unexpected different compiler versions in the same artifact: ${version} and ${res}`
            );

            res = version;
        }
    }

    return res;
}

export function isPartialSolcOutput(arg: any): arg is PartialSolcOutput {
    return arg.hasOwnProperty("contracts") && arg.hasOwnProperty("sources");
}
