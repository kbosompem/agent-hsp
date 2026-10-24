import React from "react";
import ReactDOM from "react-dom/client";
import Output, { Identify } from "./Output";
import "./output-page.css";
import "./slides.css";

const params = new URLSearchParams(location.search);
const ident = params.get("identify");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {ident ? <Identify n={ident} name={params.get("name") ?? ""} /> : <Output />}
  </React.StrictMode>
);
