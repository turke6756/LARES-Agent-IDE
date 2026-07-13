{
  "targets": [
    {
      "target_name": "lares_native",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/lares_native_win.cc"],
          "libraries": ["-lkernel32"],
          "defines": ["UNICODE", "_UNICODE", "NAPI_VERSION=8"]
        }, {
          "sources": ["src/lares_native_stub.cc"],
          "defines": ["NAPI_VERSION=8"]
        }]
      ]
    }
  ]
}
