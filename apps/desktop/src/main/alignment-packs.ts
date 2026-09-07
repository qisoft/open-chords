import type { AlignmentPack } from "./model-store.ts";

// Exact release assets; no latest lookup or generic catalog.
export const ALIGNMENT_PACKS: AlignmentPack[] = [
  {
    id: "english_mfa-3.1.0",
    language: "en",
    version: "3.1.0",
    runtime: "mfa-3.4.1",
    artifacts: [
      {
        id: "english_mfa_acoustic",
        version: "3.1.0",
        sha256: "2c08bd4f82c3943dd57ac09aeac99dbce17a1e1bfe9fd932c8d95cd13d971068",
        url: "https://github.com/MontrealCorpusTools/mfa-models/releases/download/acoustic-english_mfa-v3.1.0/english_mfa.zip",
        license: "CC-BY-4.0",
        attribution:
          "Montreal Corpus Tools \u2014 MFA model authors; attribution and model card retained with each exact artifact.",
        modelCard:
          "https://mfa-models.readthedocs.io/en/latest/acoustic/English/English%20MFA%20acoustic%20model%20v3_1_0.html",
        format: "zip",
        bytes: 92170811,
        installedBytes: 101466972,
        files: [
          {
            path: "english_mfa/final.alimdl",
            bytes: 50106787,
            sha256: "1780c629972e968a2fc4a7808c0076945df62865a0acb6ad09a02feed8d74edf",
          },
          {
            path: "english_mfa/final.mdl",
            bytes: 50106787,
            sha256: "1d3138688bfab925e108dcc9519d9efe53584aa935b41eb130450cb8ac3d48e8",
          },
          {
            path: "english_mfa/graphemes.txt",
            bytes: 287,
            sha256: "779b08e43b80dbbd0c47334db3bf1021bbb900c0abd92ec915048ac778b9701f",
          },
          {
            path: "english_mfa/lda.mat",
            bytes: 14575,
            sha256: "096f0a38207a5b58d9f5f36fa64440d26f1de7da9598acfdd7685809f08a9ffc",
          },
          {
            path: "english_mfa/meta.json",
            bytes: 4294,
            sha256: "84cba5f36f0c9dd2d84e4bce4df41f07d3fa3957bd980094f31a433786a28451",
          },
          {
            path: "english_mfa/phones.txt",
            bytes: 650,
            sha256: "e3b177d34ccb13730032fb008c48e056b27a2cefadb4af01a9562a74b2433da9",
          },
          {
            path: "english_mfa/phone_lm.fst",
            bytes: 519434,
            sha256: "b60ab3b7da03b1751fb3f5ff87124cbe7c8eec462ebf261ee4cbdd430cb2f8ba",
          },
          {
            path: "english_mfa/phone_pdf.counts",
            bytes: 195677,
            sha256: "a842e669e6c7779c261fd9f084db4acfeef595e94c2228c2a4bef4f40e2a1bec",
          },
          {
            path: "english_mfa/rules.yaml",
            bytes: 49694,
            sha256: "4cd7ccb04780a8e289b44b6e509a79b883003d68465a5b411e4197432b10c2eb",
          },
          {
            path: "english_mfa/tree",
            bytes: 468787,
            sha256: "71d2741b42fe55707ca41d908d6157bc94c6171623b156f71274b13ecb6dade7",
          },
        ],
      },
      {
        id: "english_mfa_dictionary",
        version: "3.1.0",
        sha256: "975bf9c7791535c5aec57995e0bd2b77eb7ca364d1d974c2134e07bb0f16b079",
        url: "https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-english_mfa-v3.1.0/english_mfa.dict",
        license: "CC-BY-4.0",
        attribution:
          "Montreal Corpus Tools \u2014 MFA model authors; attribution and model card retained with each exact artifact.",
        modelCard:
          "https://mfa-models.readthedocs.io/en/latest/dictionary/English/English%20MFA%20dictionary%20v3_1_0.html",
        format: "file",
        bytes: 1078195,
        installedBytes: 1078195,
      },
    ],
  },
  {
    id: "russian_mfa-3.1.0",
    language: "ru",
    version: "3.1.0",
    runtime: "mfa-3.4.1",
    artifacts: [
      {
        id: "russian_mfa_acoustic",
        version: "3.1.0",
        sha256: "bf2cdc58f3ce2cd15ee2ef1f33a56f3c901b28707b3c3fd896129050c03b3bf4",
        url: "https://github.com/MontrealCorpusTools/mfa-models/releases/download/acoustic-russian_mfa-v3.1.0/russian_mfa.zip",
        license: "CC-BY-4.0",
        attribution:
          "Montreal Corpus Tools \u2014 MFA model authors; attribution and model card retained with each exact artifact.",
        modelCard:
          "https://mfa-models.readthedocs.io/en/latest/acoustic/Russian/Russian%20MFA%20acoustic%20model%20v3_1_0.html",
        format: "zip",
        bytes: 91909566,
        installedBytes: 101199663,
        files: [
          {
            path: "russian_mfa/final.alimdl",
            bytes: 50050930,
            sha256: "ebd326abecc9f33edaa60a8f49a8977bf00b073173c8b124766693a41eb9a135",
          },
          {
            path: "russian_mfa/final.mdl",
            bytes: 50050930,
            sha256: "d8cf6dd714117400fb021e80b48ca763276303622061536cf4db26593a115872",
          },
          {
            path: "russian_mfa/graphemes.txt",
            bytes: 452,
            sha256: "9a3a3d8b81fa5c7e7ddcee63d0a1d0d375bf1bda85a9ed3d939c7b9f0fe22344",
          },
          {
            path: "russian_mfa/lda.mat",
            bytes: 14575,
            sha256: "68b37c043aa6404ad23c4ea3b20180a652d76fcd78f2eb8857bd1dd5888c8f6f",
          },
          {
            path: "russian_mfa/meta.json",
            bytes: 4240,
            sha256: "d8d3da040dce1c1e47ec6aeb96335a8b57aa56f0e13986c83b436e479b7c8dc2",
          },
          {
            path: "russian_mfa/phones.txt",
            bytes: 681,
            sha256: "92f858fa52fe459b5bd3ca928ea0139bda35bbdbf31b8b2da9b94b0d753c2a40",
          },
          {
            path: "russian_mfa/phone_lm.fst",
            bytes: 525658,
            sha256: "7f32b31e7658cc044ae16aed0afa8f0474207ee0a5cf155a928fbd3bc3c62dab",
          },
          {
            path: "russian_mfa/phone_pdf.counts",
            bytes: 138406,
            sha256: "84a94ef9e2c95cf8f1f23efc6c9faec8118c4163f48ac2f0941df2ecb701814f",
          },
          {
            path: "russian_mfa/rules.yaml",
            bytes: 1818,
            sha256: "a33942a288ca4145cb570a7820a9f80d1bea61cd31963e32d5d65f3845f5fa1a",
          },
          {
            path: "russian_mfa/tree",
            bytes: 411973,
            sha256: "a13ffdd913aae1cdb9060bded33287f82c3620a4680f1ff41229f8b525fd6ac2",
          },
        ],
      },
      {
        id: "russian_mfa_dictionary",
        version: "3.1.0",
        sha256: "f225655b9d835b73fbf510baf8283b78c5cf2d3303306005f733854670ff707f",
        url: "https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-russian_mfa-v3.1.0/russian_mfa.dict",
        license: "CC-BY-4.0",
        attribution:
          "Montreal Corpus Tools \u2014 MFA model authors; attribution and model card retained with each exact artifact.",
        modelCard:
          "https://mfa-models.readthedocs.io/en/latest/dictionary/Russian/Russian%20MFA%20dictionary%20v3_1_0.html",
        format: "file",
        bytes: 24951088,
        installedBytes: 24951088,
      },
    ],
  },
];
