terraform {
  required_version = ">= 1.15"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.0"
    }
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment; scripts/tf.sh sets it from
# the token file so the value never appears in a command line or in state.
provider "cloudflare" {}
