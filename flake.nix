{
  description = "Semantic Code Search MCP Server - Find code by meaning using AST-aware chunking, vector embeddings, and hybrid search";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bmad.url = "github:opencode/bmad";
  };

  outputs = { self, nixpkgs, flake-utils, bmad }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            yarn
            python3
            git
            gcc
            cmake
            pkg-config
            bmad.packages.${system}.bmad
          ];

          # Set environment variables for development
          shellHook = ''
            echo "Welcome to OpenCode Semantic Search MCP Server development environment"
            echo "Run 'yarn install' to install dependencies"
          '';
        };
      });
}
